/**
 * Vercel Function entry — every request is rewritten here (see vercel.json).
 * Implementation lives in src/serverless.ts so it is typechecked with the rest
 * of the API. Do not call app.listen.
 */
export { default } from '../src/serverless.js';
