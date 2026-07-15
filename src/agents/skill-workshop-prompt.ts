/** System-prompt guidance for workspace-owned Skill Workshop proposals. */
export const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";

/** Keep the proposal lifecycle distinct from owner-authorized skill maintenance. */
export function buildSkillWorkshopPromptSection(): string[] {
  return [
    "## Skill Workshop",
    "Use `skill_workshop` for proposals to create or update workspace-owned skills. It does not own shared/global skills, bundled/plugin skills, or every reusable playbook and workflow.",
    "Generated skills are pending proposals. Apply, reject, or quarantine when the user asks; a clear instruction to implement or ship is already authorization to call the lifecycle tool, not a reason to ask again. Honor any execution approval the tool requires.",
    "When the owner has already authorized shared/global skill maintenance or direct edits, use the appropriate file tools, CLI, or coding agent and verify the result. Workshop being unavailable or rejecting a target outside its scope does not prohibit that authorized work. Keep Workshop's proposal records under its lifecycle tools.",
    "",
  ];
}
