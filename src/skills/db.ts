// ============================================================================
// SKILLS DOMAIN - Prepared statements (re-exported from db/index.ts)
// ============================================================================

export {
  upsertSkill,
  getSkillById,
  getSkillByPath,
  listSkillsStmt,
  searchSkillsFTSStmt,
  getAllSkillEmbeddingsStmt,
  updateSkillEmbeddingStmt,
  writeSkillVec,
  updateSkillContentStmt,
  incrementSkillSelectionsStmt,
  softDeleteSkillStmt,
  insertSkillTagStmt,
  getSkillTagsStmt,
  insertSkillParentStmt,
} from "../db/index.ts";
