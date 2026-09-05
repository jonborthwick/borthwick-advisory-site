import { runScout } from './dealdesk.mjs';
export const config = { schedule: '@daily' };
export default async () => { try { console.log('Deal scout result', await runScout()); } catch (err) { console.error('Deal scout failed', err); } };
