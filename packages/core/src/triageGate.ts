// What the mail funnel's Stage 2 AI check (the `comms.triage` task, apps/server/src/lib/triageGate.ts)
// reads of a message. It lives here, not in the server, because the web app has to say the same
// thing to the user: the inbox's Blocked tab tells them how much of a message the check read
// before keeping it out (https://github.com/bgoleno/opportun/issues/104). One constant, so the
// sentence the user reads cannot drift from what the gate actually sends.

/** How much of the body the gate is given. The rest never leaves the machine. */
export const GATE_INPUT_CHARS = 500;
