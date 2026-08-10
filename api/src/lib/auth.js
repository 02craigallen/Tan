const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const TOKEN_TTL = "12h";

function hashPassword(password) {
    return bcrypt.hash(password, 10);
}

function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}

function signToken(user) {
    return jwt.sign({ sub: user.id, email: user.email, name: user.name, role: user.role, watch: user.watch || null, personId: user.personId || null }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// Returns the decoded user payload from a request's Authorization header, or null if missing/invalid.
function userFromRequest(request) {
    const header = request.headers.get("authorization") || "";
    const match = header.match(/^Bearer (.+)$/i);
    if (!match) return null;
    try {
        return jwt.verify(match[1], process.env.JWT_SECRET);
    }
    catch {
        return null;
    }
}

function unauthorized() {
    return { status: 401, jsonBody: { error: "Not signed in, or your session expired — please log in again." } };
}

function forbidden(message) {
    return { status: 403, jsonBody: { error: message || "You don't have permission to do that." } };
}

module.exports = { hashPassword, verifyPassword, signToken, userFromRequest, unauthorized, forbidden };
