const { app } = require("@azure/functions");
const crypto = require("crypto");
const { container, readDoc } = require("../lib/db");
const { userFromRequest, unauthorized, forbidden } = require("../lib/auth");
const { COURSES_CONTAINER, ENROLMENTS_CONTAINER, ensureTrainingContainers, isTrainingManager, EMAIL_RE } = require("../lib/training");

app.http("training-courses-list-create", {
    methods: ["GET", "POST"],
    authLevel: "anonymous",
    route: "training/courses",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        await ensureTrainingContainers();

        if (request.method === "GET") {
            const isManager = isTrainingManager(user);
            const query = isManager ? "SELECT * FROM c" : "SELECT * FROM c WHERE c.status = 'published'";
            const { resources: courses } = await container(COURSES_CONTAINER).items.query(query).fetchAll();

            const { resources: myEnrolments } = await container(ENROLMENTS_CONTAINER).items
                .query({ query: "SELECT * FROM c WHERE c.userId = @email AND c.status = 'confirmed'", parameters: [{ name: "@email", value: user.email }] })
                .fetchAll();
            const enrolledSet = new Set(myEnrolments.map((e) => e.courseId));

            const result = courses
                .map((c) => ({ ...c, userEnrolled: enrolledSet.has(c.id), spacesRemaining: Math.max(0, (c.capacity || 0) - (c.confirmedCount || 0)) }))
                .sort((a, b) => (a.courseDate + (a.startTime || "")).localeCompare(b.courseDate + (b.startTime || "")));

            return { headers: { "Cache-Control": "no-store" }, jsonBody: { courses: result } };
        }

        // POST — create
        if (!isTrainingManager(user)) return forbidden("Only training management can create courses.");
        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing body." } };
        }
        const required = ["title", "courseDate", "startTime", "endTime", "capacity", "confirmationEmail"];
        const missing = required.filter((k) => body[k] === undefined || body[k] === null || body[k] === "");
        if (missing.length) return { status: 400, jsonBody: { error: `Missing required field(s): ${missing.join(", ")}` } };
        if (!EMAIL_RE.test(body.confirmationEmail)) return { status: 400, jsonBody: { error: "Course confirmation email address doesn't look valid." } };
        const capacity = Number(body.capacity);
        if (!Number.isFinite(capacity) || capacity < 1) return { status: 400, jsonBody: { error: "Capacity must be a positive number." } };

        const now = new Date().toISOString();
        const course = {
            id: crypto.randomUUID(),
            title: String(body.title).trim(),
            category: (body.category || "").trim(),
            description: (body.description || "").trim(),
            courseDate: body.courseDate,
            startTime: body.startTime,
            endTime: body.endTime,
            location: (body.location || "").trim(),
            trainer: (body.trainer || "").trim(),
            capacity,
            confirmationEmail: body.confirmationEmail.trim().toLowerCase(),
            joiningInstructions: (body.joiningInstructions || "").trim(),
            status: body.status === "published" ? "published" : "draft",
            confirmedCount: 0,
            createdByUserId: user.email,
            createdAt: now,
            updatedAt: now,
        };
        await container(COURSES_CONTAINER).items.create(course);
        return { status: 201, jsonBody: { course } };
    },
});

app.http("training-course-item", {
    methods: ["GET", "PUT"],
    authLevel: "anonymous",
    route: "training/courses/{id}",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        await ensureTrainingContainers();
        const id = decodeURIComponent(request.params.id);
        const existing = await readDoc(COURSES_CONTAINER, id);
        if (!existing) return { status: 404, jsonBody: { error: "Course not found." } };

        if (request.method === "GET") {
            if (existing.status !== "published" && !isTrainingManager(user)) return { status: 404, jsonBody: { error: "Course not found." } };
            const enrolment = await readDoc(ENROLMENTS_CONTAINER, `${id}::${user.email}`);
            return { jsonBody: { course: { ...existing, userEnrolled: !!(enrolment && enrolment.status === "confirmed"), spacesRemaining: Math.max(0, (existing.capacity || 0) - (existing.confirmedCount || 0)) } } };
        }

        // PUT — edit
        if (!isTrainingManager(user)) return forbidden("Only training management can edit courses.");
        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing body." } };
        }
        if (body.confirmationEmail && !EMAIL_RE.test(body.confirmationEmail)) return { status: 400, jsonBody: { error: "Course confirmation email address doesn't look valid." } };
        const updated = {
            ...existing,
            title: body.title !== undefined ? String(body.title).trim() : existing.title,
            category: body.category !== undefined ? body.category.trim() : existing.category,
            description: body.description !== undefined ? body.description.trim() : existing.description,
            courseDate: body.courseDate || existing.courseDate,
            startTime: body.startTime || existing.startTime,
            endTime: body.endTime || existing.endTime,
            location: body.location !== undefined ? body.location.trim() : existing.location,
            trainer: body.trainer !== undefined ? body.trainer.trim() : existing.trainer,
            capacity: body.capacity !== undefined ? Number(body.capacity) : existing.capacity,
            confirmationEmail: body.confirmationEmail ? body.confirmationEmail.trim().toLowerCase() : existing.confirmationEmail,
            joiningInstructions: body.joiningInstructions !== undefined ? body.joiningInstructions.trim() : existing.joiningInstructions,
            status: body.status || existing.status,
            updatedAt: new Date().toISOString(),
        };
        await container(COURSES_CONTAINER).items.upsert(updated);
        return { jsonBody: { course: updated } };
    },
});

app.http("training-course-cancel", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "training/courses/{id}/cancel",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        if (!isTrainingManager(user)) return forbidden("Only training management can cancel courses.");
        await ensureTrainingContainers();
        const id = decodeURIComponent(request.params.id);
        const existing = await readDoc(COURSES_CONTAINER, id);
        if (!existing) return { status: 404, jsonBody: { error: "Course not found." } };
        const updated = { ...existing, status: "cancelled", updatedAt: new Date().toISOString() };
        await container(COURSES_CONTAINER).items.upsert(updated);
        return { jsonBody: { course: updated } };
    },
});

app.http("training-course-attendees", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "training/courses/{id}/attendees",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        if (!isTrainingManager(user)) return forbidden("Only training management can view attendees.");
        await ensureTrainingContainers();
        const id = decodeURIComponent(request.params.id);
        const course = await readDoc(COURSES_CONTAINER, id);
        if (!course) return { status: 404, jsonBody: { error: "Course not found." } };

        const { resources: enrolments } = await container(ENROLMENTS_CONTAINER).items
            .query({ query: "SELECT * FROM c WHERE c.courseId = @id AND c.status = 'confirmed'", parameters: [{ name: "@id", value: id }] }, { partitionKey: id })
            .fetchAll();

        const attendees = await Promise.all(enrolments.map(async (e) => {
            const u = await readDoc("users", e.userId);
            return { email: e.userId, name: (u && u.name) || e.userName || e.userId, enrolledAt: e.enrolledAt, enrolmentSource: e.enrolmentSource, status: e.status };
        }));
        attendees.sort((a, b) => (a.enrolledAt || "").localeCompare(b.enrolledAt || ""));

        return { headers: { "Cache-Control": "no-store" }, jsonBody: { course, attendees, capacity: course.capacity, confirmed: attendees.length, spacesRemaining: Math.max(0, course.capacity - attendees.length) } };
    },
});

app.http("training-people-search", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "training/people",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        if (!isTrainingManager(user)) return forbidden("Only training management can browse people to add.");
        const { resources } = await container("users").items.query("SELECT c.email, c.name FROM c").fetchAll();
        return { headers: { "Cache-Control": "no-store" }, jsonBody: { people: resources } };
    },
});
