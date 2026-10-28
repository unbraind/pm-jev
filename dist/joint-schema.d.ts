import type { Questions, SystemOneResult } from "@typesafe-ai/sdk";
/** Portable joint constraint document version. */
export declare const JOINT_VERSION = "pm-jev-joint/1";
/** Hard input and output bounds keep agent receipts predictable. */
export declare const JOINT_LIMITS: Readonly<{
    bytes: 262144;
    questions: 32;
    constraints: 32;
    options: 32;
}>;
/** A choice label, exact score, or explicit-threshold noul outcome. */
export type JointPredicate = {
    readonly question: string;
    readonly value: string | number;
    readonly threshold?: never;
} | {
    readonly question: string;
    readonly value: boolean;
    readonly threshold: number;
};
/** Declarative constraints never carry executable code or mutation authority. */
export type JointConstraint = {
    readonly id: string;
    readonly kind: "exclusive";
    readonly answers: readonly JointPredicate[];
} | {
    readonly id: string;
    readonly kind: "requires";
    readonly if: JointPredicate;
    readonly then: JointPredicate;
} | {
    readonly id: string;
    readonly kind: "relationship";
    readonly when: JointPredicate;
    readonly source: string;
    readonly target: string;
    readonly relationship: string;
};
/** A complete selected batch uses the existing producer question and raw answer contracts. */
export interface JointInput {
    readonly version: typeof JOINT_VERSION;
    readonly questions: Questions;
    readonly result: SystemOneResult<Questions>;
    readonly constraints: readonly JointConstraint[];
}
/** Refusals are content-free; failed semantic constraints are ordinary reports. */
export type JointRefusalCode = "invalid_input" | "input_unreadable" | "host_required" | "host_read_failed" | "invalid_report";
/** Typed invalid-input and unavailable-host failures with actionable remedies. */
export declare class JointRefusal extends Error {
    /** Stable machine-readable reason independent of source content. */
    readonly code: JointRefusalCode;
    /** Concrete next step that never repeats tracker or proposal data. */
    readonly remedy: string;
    /** Preserve a stable machine code without leaking input or host error contents. */
    constructor(code: JointRefusalCode, remedy: string);
}
/** Parse once at the SDK/CLI boundary; share producer normalization and validate every raw answer. */
export declare function parseJointInput(raw: unknown): JointInput;
//# sourceMappingURL=joint-schema.d.ts.map