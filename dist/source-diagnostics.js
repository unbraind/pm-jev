import { createPmCliExpectedError } from "@unbrained/pm-cli/sdk";
/** Explicit recovery path for private trackers; never an automatic public-source fallback. */
export const LOCAL_SOURCE_GUIDANCE = "For private local evaluation, pass --local-unverified --from <tracker>.";
/** Remove credential material, endpoint details and local identities from one diagnostic line. */
export function redactedSourceLine(text) {
    return text.split(/\r?\n/, 1)[0]
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/https?:\/\/\S+/gi, "[redacted-url]")
        .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted-authorization]")
        .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, "[redacted-token]")
        .replace(/\b(?:[A-Z_]*(?:TOKEN|PASSWORD|SECRET|API_KEY)|token|password|secret|api_key)\s*[=:]\s*\S+/gi, "[redacted-credential]")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
        .replace(/(?:[A-Z]:\\|\/(?:home|Users|tmp|private|var|run|mnt|opt)\/)[^\s"']+/gi, "[redacted-path]")
        .replace(/[\x00-\x1f\x7f]/g, "")
        .slice(0, 500);
}
/** Classify gh subprocess failures and retain only a redacted first stderr line. */
export function ghInspectionFailure(repository, code, status, stderr) {
    let kind;
    let fix;
    if (code === "ENOENT" || status === 127 || /(?:gh: command not found|executable.*not found)/i.test(stderr)) {
        kind = "gh missing";
        fix = "Install GitHub CLI (gh) and add it to PATH";
    }
    else if (/not (?:logged|authenticated)|gh auth login|authentication (?:required|failed)|requires authentication|bad credentials|HTTP 401/i.test(stderr)) {
        kind = "not authenticated";
        fix = "Run gh auth login (or replace an invalid GH_TOKEN/GITHUB_TOKEN) and retry with an account that can read the public repository";
    }
    else if (/rate.limit|HTTP 429|API rate limit exceeded/i.test(stderr)) {
        kind = "rate-limited";
        fix = "Wait for the GitHub rate limit to reset; check gh api rate_limit";
    }
    else if (/could not resolve to a repository|repository.*(?:not found|private)|HTTP 404/i.test(stderr)) {
        kind = "repository not found/private";
        fix = "Check the repository name and public visibility; private repositories are ineligible";
    }
    else if (/network|connect|timed? ?out|timeout|resolve host|TLS|certificate|ENETUNREACH|EAI_AGAIN/i.test(stderr) || code === "ETIMEDOUT") {
        kind = "network";
        fix = "Restore access to api.github.com (DNS, proxy, TLS and firewall) and retry";
    }
    else {
        kind = "unrecognized gh failure";
        fix = "Run gh repo view for the named repository and resolve the reported error";
    }
    return createPmCliExpectedError(`Public tracker inspection failed for ${redactedSourceLine(repository)} (gh: ${kind}). ${fix}. ${LOCAL_SOURCE_GUIDANCE} gh stderr: ${redactedSourceLine(stderr) || "(empty)"}`);
}
//# sourceMappingURL=source-diagnostics.js.map