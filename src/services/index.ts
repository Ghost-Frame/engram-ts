// ============================================================================
// Service barrel -- wires all consolidated Syntheos service routes
// Import this once in src/routes/index.ts to enable all service endpoints.
// ============================================================================

export { handleThymusRoutes } from "./thymus/routes.ts";
export { handleSomaRoutes } from "./soma/routes.ts";
export { handleChiasmRoutes } from "./chiasm/routes.ts";
export { handleAxonRoutes } from "./axon/routes.ts";
export { handleLoomRoutes } from "./loom/routes.ts";
export { handleBrocaRoutes } from "./broca/routes.ts";
