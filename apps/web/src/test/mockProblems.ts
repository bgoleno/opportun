// What a mocked API was told that cannot be what the test means
// (https://github.com/bgoleno/opportun/issues/941). Thrown inside the mocked fetch it would reach the
// page as a network failure, and the test could pass on it: so it is kept, and the test fails after.
let problems: string[] = [];

export function mockProblem(message: string): void {
  problems.push(message);
}

/** What was kept since the last call (setup.ts fails the test on any). */
export function takeMockProblems(): string[] {
  const taken = problems;
  problems = [];
  return taken;
}
