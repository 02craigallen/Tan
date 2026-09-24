const { app } = require("@azure/functions");
const { readDoc, container } = require("../lib/db");
const { userFromRequest, unauthorized, forbidden } = require("../lib/auth");
const {
    COURSES_CONTAINER, ENROLMENTS_CONTAINER, ensureTrainingContainers, isTrainingManager,
    todayISO, enrolUser, cancelEnrolment, sendEmployeeConfirmation, sendManagementConfirmation,
} = require("../lib/training");

const REASON_MESSAGES = {
    duplicate: "Already enrolled on this course.",
    full: "This course is full.",
    "not-published": "This course isn't open for enrolment.",
    "not-found": "Course not found.",
    contended: "Enrolment is busy right now — please try again in a moment.",
};

app.http("training-enrol", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "training/courses/{id}/enrol",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        await ensureTrainingContainers();
        const id = decodeURIComponent(request.params.id);
        const course = await readDoc(COURSES_CONTAINER, id);
        if (!course) return { status: 404, jsonBody: { error: "Course not found." } };
        if (course.status === "cancelled") return { status: 400, jsonBody: { error: "This course has been cancelled." } };
        if (course.status !== "published") return { status: 400, jsonBody: { error: "This course isn't open for enrolment." } };
        if (course.courseDate < todayISO()) return { status: 400, jsonBody: { error: "This course has already taken place." } };

        const result = await enrolUser({ course, user, enrolledByEmail: user.email, source: "self" });
        if (!result.ok) return { status: 409, jsonBody: { error: REASON_MESSAGES[result.reason] || "Couldn't enrol you on this course." } };

        await sendEmployeeConfirmation(result.course, user);
        await sendManagementConfirmation(result.course, [{ name: user.name, email: user.email }]);

        return { status: 201, jsonBody: { course: result.course, enrolment: result.enrolment } };
    },
});

app.http("training-cancel-enrolment", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "training/courses/{id}/cancel-enrolment",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        await ensureTrainingContainers();
        const id = decodeURIComponent(request.params.id);
        const result = await cancelEnrolment({ courseId: id, userEmail: user.email });
        if (!result.ok) return { status: 400, jsonBody: { error: "You're not enrolled on this course." } };
        return { jsonBody: { ok: true } };
    },
});

app.http("training-enrol-others", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "training/courses/{id}/enrol-others",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        if (!isTrainingManager(user)) return forbidden("Only training management can add people to a course.");
        await ensureTrainingContainers();
        const id = decodeURIComponent(request.params.id);
        const course = await readDoc(COURSES_CONTAINER, id);
        if (!course) return { status: 404, jsonBody: { error: "Course not found." } };
        if (course.status === "cancelled") return { status: 400, jsonBody: { error: "This course has been cancelled." } };

        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing body." } };
        }
        const emails = Array.isArray(body.emails) ? body.emails : [];
        if (emails.length === 0) return { status: 400, jsonBody: { error: "No people selected." } };

        const added = [];
        const skipped = [];
        let latestCourse = course;
        for (const email of emails) {
            const person = await readDoc("users", String(email).toLowerCase());
            if (!person) {
                skipped.push({ email, reason: "No account found." });
                continue;
            }
            const result = await enrolUser({ course: latestCourse, user: person, enrolledByEmail: user.email, source: "management" });
            if (!result.ok) {
                skipped.push({ email, reason: REASON_MESSAGES[result.reason] || "Couldn't add." });
                continue;
            }
            latestCourse = result.course;
            added.push({ name: person.name, email: person.email });
            await sendEmployeeConfirmation(latestCourse, person);
        }
        if (added.length > 0) {
            await sendManagementConfirmation(latestCourse, added);
        }
        return { jsonBody: { course: latestCourse, added, skipped } };
    },
});

app.http("training-remove-attendee", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "training/courses/{id}/remove-attendee",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        if (!isTrainingManager(user)) return forbidden("Only training management can remove attendees.");
        await ensureTrainingContainers();
        const id = decodeURIComponent(request.params.id);
        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing body." } };
        }
        if (!body.email) return { status: 400, jsonBody: { error: "email is required." } };
        const result = await cancelEnrolment({ courseId: id, userEmail: String(body.email).toLowerCase() });
        if (!result.ok) return { status: 400, jsonBody: { error: "That person isn't enrolled on this course." } };
        return { jsonBody: { ok: true } };
    },
});

app.http("training-my-courses", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "training/my-courses",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        await ensureTrainingContainers();
        const { resources: enrolments } = await container(ENROLMENTS_CONTAINER).items
            .query({ query: "SELECT * FROM c WHERE c.userId = @email AND c.status = 'confirmed'", parameters: [{ name: "@email", value: user.email }] })
            .fetchAll();
        const courses = await Promise.all(enrolments.map((e) => readDoc(COURSES_CONTAINER, e.courseId)));
        const today = todayISO();
        const upcoming = [];
        const previous = [];
        courses.forEach((c, i) => {
            if (!c) return;
            const item = { ...c, enrolment: enrolments[i] };
            if (c.courseDate >= today && c.status !== "cancelled") upcoming.push(item);
            else previous.push(item);
        });
        upcoming.sort((a, b) => a.courseDate.localeCompare(b.courseDate));
        previous.sort((a, b) => b.courseDate.localeCompare(a.courseDate));
        return { headers: { "Cache-Control": "no-store" }, jsonBody: { upcoming, previous } };
    },
});
