import '@fastify/secure-session';

// Declare the shape of our session cookie so `req.session.get/set('userId')` is typed.
declare module '@fastify/secure-session' {
  interface SessionData {
    userId: string;
  }
}
