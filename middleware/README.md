# Middleware

Shared Express middleware belongs here. Route modules should import middleware
from this directory instead of defining cross-cutting request behavior inside
`routes/`.

- `auth.js`: JWT verification and role-based authorization guards.

Middleware may inspect and enrich `req`, reject a request, or call `next()`. It
must not contain domain workflows or issue database queries.
