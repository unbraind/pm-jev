import { createPmCliExpectedError } from "@unbrained/pm-cli/sdk";
/**
 * Parse and validate a caller-supplied question map for `jev ask`.
 *
 * Structural mirror of the SDK `Questions` contract: a nonempty object of
 * named questions where `choice` needs a nonempty criteria map, `score` needs
 * a rubric of 2–10 described levels, and `noul` accepts optional true/false
 * descriptions. Instructions may be text, JSON, or absent.
 *
 * @param raw - Parsed JSON from the questions file.
 * @returns The validated question map.
 * @throws {PmCliExpectedError} The document violates the Questions contract.
 */
export function parseQuestionsDocument(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw createPmCliExpectedError("Questions file must contain a JSON object of named questions.", {
            context: { code: "jev_questions_shape" },
        });
    }
    const entries = Object.entries(raw);
    if (entries.length === 0) {
        throw createPmCliExpectedError("Questions file must define at least one question.", {
            context: { code: "jev_questions_empty" },
        });
    }
    const questions = Object.create(null);
    for (const [name, value] of entries) {
        const question = requireQuestionRecord(name, value);
        const instructions = requireEntryType(name, question.instructions, "instructions");
        if (question.type === "choice") {
            const rawCriteria = requireCriteriaRecord(name, question.criteria);
            const criteria = Object.create(null);
            for (const [label, description] of Object.entries(rawCriteria)) {
                criteria[label] = requireEntryType(name, description, `criteria.${label}`);
            }
            questions[name] = { type: "choice", instructions, criteria };
        }
        else if (question.type === "score") {
            const rubric = requireRubric(name, question.criteria).map(/** Validate each supplied rubric description. */ (level, index) => requireEntryType(name, level, `criteria[${index}]`));
            questions[name] = { type: "score", instructions, criteria: rubric };
        }
        else {
            const criteria = requireNoulCriteria(name, question.criteria);
            // A bare noul key names its proposition; make that existing implicit instruction explicit for the SDK.
            const proposition = instructions ?? name;
            questions[name] = criteria === null ? { type: "noul", instructions: proposition } : { type: "noul", instructions: proposition, criteria };
        }
    }
    return questions;
}
/**
 * Narrow one question instructions or criterion value to the SDK entry type.
 *
 * Accepts text, a JSON object or array, or `null` (undescribed); `undefined`
 * is also accepted because instructions and criteria are optional fields.
 *
 * @param name - Question name used in diagnostics.
 * @param value - Raw instructions or criterion value of unknown shape.
 * @param field - Field path used in diagnostics.
 * @returns The value narrowed to the SDK `EntryType` union.
 * @throws {PmCliExpectedError} The value is a boolean, number, or other
 *         non-entry shape the endpoint would reject.
 */
function requireEntryType(name, value, field) {
    if (value === undefined || value === null || typeof value === "string")
        return value;
    if (typeof value === "object")
        return value;
    throw createPmCliExpectedError(`Question "${name}" field ${field} must be text, a JSON object or array, or null.`, { context: { code: "jev_question_entry_type" } });
}
/**
 * Validate one question entry's base record and type discriminator.
 *
 * @param name - Question name used in diagnostics.
 * @param value - Raw question value of unknown shape.
 * @returns The question record with its `type` and `criteria` fields.
 * @throws {PmCliExpectedError} The entry is not a known question type.
 */
function requireQuestionRecord(name, value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw createPmCliExpectedError(`Question "${name}" must be an object.`, { context: { code: "jev_question_shape" } });
    }
    const record = value;
    if (record.type !== "choice" && record.type !== "score" && record.type !== "noul") {
        throw createPmCliExpectedError(`Question "${name}" has unsupported type ${JSON.stringify(record.type) ?? "undefined"}; supported: choice, score, noul.`, { context: { code: "jev_question_type" } });
    }
    return { type: record.type, criteria: record.criteria, instructions: record.instructions };
}
/**
 * Validate a choice question's criteria map.
 *
 * @param name - Question name used in diagnostics.
 * @param criteria - Raw criteria value of unknown shape.
 * @returns The criteria as a label→description map.
 * @throws {PmCliExpectedError} The criteria are not a nonempty plain object.
 */
function requireCriteriaRecord(name, criteria) {
    if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) {
        throw createPmCliExpectedError(`Choice question "${name}" needs a nonempty criteria object of option labels.`, {
            context: { code: "jev_choice_criteria" },
        });
    }
    const labels = Object.keys(criteria);
    if (labels.length === 0 || labels.length > 255) {
        throw createPmCliExpectedError(`Choice question "${name}" needs between 1 and 255 option labels.`, {
            context: { code: "jev_choice_criteria" },
        });
    }
    return criteria;
}
/**
 * Validate a score question's ordered rubric.
 *
 * @param name - Question name used in diagnostics.
 * @param criteria - Raw criteria value of unknown shape.
 * @returns The rubric as an array of level descriptions.
 * @throws {PmCliExpectedError} The rubric is not an array of at least two entries.
 */
function requireRubric(name, criteria) {
    if (!Array.isArray(criteria) || criteria.length < 2) {
        throw createPmCliExpectedError(`Score question "${name}" needs an ordered criteria rubric of at least 2 levels.`, {
            context: { code: "jev_score_criteria" },
        });
    }
    return criteria;
}
/**
 * Validate a noul question's optional outcome descriptions.
 *
 * @param name - Question name used in diagnostics.
 * @param criteria - Raw criteria value of unknown shape.
 * @returns The true/false descriptions when present, otherwise `null`.
 * @throws {PmCliExpectedError} The criteria are not a plain object or carry
 *         non-entry descriptions.
 */
function requireNoulCriteria(name, criteria) {
    if (criteria === undefined || criteria === null)
        return null;
    if (typeof criteria !== "object" || Array.isArray(criteria)) {
        throw createPmCliExpectedError(`Noul question "${name}" criteria must be an object with optional true/false descriptions.`, {
            context: { code: "jev_noul_criteria" },
        });
    }
    const record = criteria;
    const narrowed = {};
    for (const outcome of ["true", "false"]) {
        const value = record[outcome];
        if (value !== undefined)
            narrowed[outcome] = requireEntryType(name, value, `criteria.${outcome}`);
    }
    return narrowed;
}
//# sourceMappingURL=questions-document.js.map