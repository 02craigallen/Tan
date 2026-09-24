const { container, ensureContainer, readDoc } = require("./db");
const { sendEmail } = require("./email");

const COURSES_CONTAINER = "training-courses";
const ENROLMENTS_CONTAINER = "training-enrolments";

async function ensureTrainingContainers() {
    await ensureContainer(COURSES_CONTAINER, "/id");
    await ensureContainer(ENROLMENTS_CONTAINER, "/courseId");
}

function isTrainingManager(user) {
    return !!(user && (user.role === "management" || user.role === "admin"));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fmtDateUK(iso) {
    if (!iso) return "";
    return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
}
function firstName(name) {
    return (name || "").trim().split(" ")[0] || "there";
}
function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function sendEmployeeConfirmation(course, user) {
    const subject = `Training Course Confirmation – ${course.title}`;
    const joining = course.joiningInstructions ? `<p>${course.joiningInstructions}</p>` : "";
    const html = `<p>Hi ${firstName(user.name)},</p>
<p>Your place on the following training course has been confirmed.</p>
<p>Course: ${course.title}<br>Date: ${fmtDateUK(course.courseDate)}<br>Time: ${course.startTime} – ${course.endTime}<br>Location: ${course.location || "TBC"}</p>
${joining}
<p>You can view your training courses by logging into your account and opening Training &gt; My Courses.</p>
<p>Thanks.</p>`;
    return sendEmail({ to: user.email, subject, html, context: { kind: "training-employee-confirmation", courseId: course.id, userId: user.email } });
}

async function sendManagementConfirmation(course, attendees) {
    if (!course.confirmationEmail || attendees.length === 0) return { ok: false, error: "Nothing to send." };
    const subject = attendees.length > 1 ? `New Training Enrolments – ${course.title}` : `New Training Enrolment – ${course.title}`;
    const rows = attendees.map((a) => `Name: ${a.name || a.email}<br>Email: ${a.email}`).join("<br><br>");
    const html = `<p>${attendees.length > 1 ? "Users have" : "A user has"} enrolled on the following training course.</p>
<p>Course: ${course.title}<br>Date: ${fmtDateUK(course.courseDate)}<br>Time: ${course.startTime} – ${course.endTime}</p>
<p>Attendee${attendees.length > 1 ? "s" : ""}:</p>
<p>${rows}</p>
<p>Current attendance:</p>
<p>${course.confirmedCount} / ${course.capacity}</p>
<p>The attendee list can be viewed in the Training Management section.</p>`;
    return sendEmail({ to: course.confirmationEmail, subject, html, context: { kind: "training-management-confirmation", courseId: course.id } });
}

// Atomically enrol one user onto one course: prevents duplicate enrolment and capacity
// overrun even under concurrent requests. The course document's confirmedCount is the
// single source of truth for capacity, updated via Cosmos ETag optimistic concurrency
// (read, check, conditional replace, retry on conflict) — and the enrolment document's own
// id (courseId::userId) is created (not upserted) for a brand-new enrolment, so Cosmos
// itself rejects a genuine duplicate race with a 409, at which point the reserved slot is
// handed back.
async function enrolUser({ course, user, enrolledByEmail, source }) {
    const enrolmentId = `${course.id}::${user.email}`;
    const coursesC = container(COURSES_CONTAINER);
    const enrolmentsC = container(ENROLMENTS_CONTAINER);

    const existing = await readDoc(ENROLMENTS_CONTAINER, enrolmentId);
    if (existing && existing.status === "confirmed") {
        return { ok: false, reason: "duplicate" };
    }

    const MAX_ATTEMPTS = 8;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const { resource: freshCourse } = await coursesC.item(course.id, course.id).read();
        if (!freshCourse) return { ok: false, reason: "not-found" };
        if (freshCourse.status !== "published") return { ok: false, reason: "not-published" };
        if ((freshCourse.confirmedCount || 0) >= freshCourse.capacity) return { ok: false, reason: "full" };

        const nextCount = (freshCourse.confirmedCount || 0) + 1;
        try {
            await coursesC.item(course.id, course.id).replace({ ...freshCourse, confirmedCount: nextCount, updatedAt: new Date().toISOString() }, { accessCondition: { type: "IfMatch", condition: freshCourse._etag } });
        }
        catch (e) {
            if (e.code === 412) continue; // someone else updated the course first — retry
            throw e;
        }

        try {
            let enrolment;
            if (existing) {
                enrolment = { ...existing, status: "confirmed", enrolledAt: new Date().toISOString(), cancelledAt: null, enrolledByUserId: enrolledByEmail, enrolmentSource: source, updatedAt: new Date().toISOString() };
                await enrolmentsC.items.upsert(enrolment);
            }
            else {
                enrolment = { id: enrolmentId, courseId: course.id, userId: user.email, userName: user.name || "", status: "confirmed", enrolledByUserId: enrolledByEmail, enrolmentSource: source, enrolledAt: new Date().toISOString(), cancelledAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
                await enrolmentsC.items.create(enrolment); // 409 if a concurrent duplicate request won the race
            }
            return { ok: true, course: { ...freshCourse, confirmedCount: nextCount }, enrolment };
        }
        catch (e) {
            await coursesC.item(course.id, course.id).replace({ ...freshCourse, confirmedCount: freshCourse.confirmedCount || 0 }).catch(() => {});
            if (e.code === 409) return { ok: false, reason: "duplicate" };
            throw e;
        }
    }
    return { ok: false, reason: "contended" };
}

async function cancelEnrolment({ courseId, userEmail }) {
    const enrolmentId = `${courseId}::${userEmail}`;
    const existing = await readDoc(ENROLMENTS_CONTAINER, enrolmentId);
    if (!existing || existing.status !== "confirmed") return { ok: false, reason: "not-enrolled" };

    const coursesC = container(COURSES_CONTAINER);
    const enrolmentsC = container(ENROLMENTS_CONTAINER);
    await enrolmentsC.items.upsert({ ...existing, status: "cancelled", cancelledAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

    const MAX_ATTEMPTS = 8;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const { resource: freshCourse } = await coursesC.item(courseId, courseId).read();
        if (!freshCourse) return { ok: true };
        const nextCount = Math.max(0, (freshCourse.confirmedCount || 0) - 1);
        try {
            await coursesC.item(courseId, courseId).replace({ ...freshCourse, confirmedCount: nextCount, updatedAt: new Date().toISOString() }, { accessCondition: { type: "IfMatch", condition: freshCourse._etag } });
            return { ok: true };
        }
        catch (e) {
            if (e.code === 412) continue;
            throw e;
        }
    }
    return { ok: false, reason: "contended" };
}

module.exports = {
    COURSES_CONTAINER, ENROLMENTS_CONTAINER, ensureTrainingContainers, isTrainingManager, EMAIL_RE,
    fmtDateUK, firstName, todayISO, sendEmployeeConfirmation, sendManagementConfirmation, enrolUser, cancelEnrolment,
};
