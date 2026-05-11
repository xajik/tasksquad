/**
 * Builds the body of a supervisor verification task.
 * Kept in its own file so it can be unit-tested and swapped per-planner in v2.
 */
export function buildSupervisorBody(
  plannerName: string,
  phaseName: string,
  lastResponse: string,
): string {
  return `You are a supervisor verifying whether a phase meets its definition of done.

Planner: ${plannerName}
Phase: ${phaseName}

Output from phase agent:
---
${lastResponse}
---

Respond ONLY with valid JSON. Include a brief explanation of your decision:
{"approved": true, "explanation": "Phase output fully satisfies the requirements because ..."}
or
{"approved": false, "explanation": "Phase output is missing X / incorrect because ..."}`
}
