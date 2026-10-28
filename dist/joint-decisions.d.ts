import type { PmClient } from "@unbrained/pm-cli/sdk";
import type { RelationshipKindRegistry } from "@unbrained/pm-cli/sdk/graph";
import { JOINT_VERSION } from "./joint-schema.ts";
/** Optional tracker context is needed only for selected relationship additions. */
export interface JointContext {
    readonly client: PmClient;
    readonly registry?: RelationshipKindRegistry;
}
/** An exact observed answer plus its caller-declared predicate, without full distributions. */
export interface JointWitnessAnswer {
    readonly question: string;
    readonly answer: string | number;
    readonly expected: string | number | boolean;
    readonly threshold?: number;
}
/** Codes distinguish semantic incompatibility from an invalid batch or unavailable host. */
export type JointViolationCode = "exclusive" | "requires" | "relationship_edge" | "relationship_hierarchy" | "relationship_cardinality" | "relationship_ordering";
/** Each failure explains which declared rules and unchanged answers conflict. */
export interface JointViolation {
    readonly constraints: readonly string[];
    readonly code: JointViolationCode;
    readonly witness: readonly JointWitnessAnswer[];
    readonly remedy: string;
}
/** Compact preflight evidence is advisory and never grants mutation authority. */
export interface JointReport {
    readonly version: typeof JOINT_VERSION;
    readonly ok: boolean;
    readonly exit_code?: 1;
    readonly questions: number;
    readonly constraints: number;
    readonly relationship_additions: number;
    readonly violations: readonly JointViolation[];
    readonly mutations: 0;
    readonly inference_calls: 0;
    readonly mutation_authority: "none";
}
/** Check every emitted numeric domain even when a future producer changes report construction. */
export declare function validateJointReportNumbers(report: JointReport): void;
/** Validate one immutable selected batch; no model calls, apply, journal, imports or tracker writes. */
export declare function validateJointDecisions(raw: unknown, context?: JointContext): Promise<JointReport>;
//# sourceMappingURL=joint-decisions.d.ts.map