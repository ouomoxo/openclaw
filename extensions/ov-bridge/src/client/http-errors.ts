import type { ContractError } from "@ouomoxo/ov-agent-contracts";
import type { OvBridgeErrorCode } from "../types.js";

export interface MappedError {
  code: OvBridgeErrorCode;
  retryable: boolean;
  message: string;
}

/** Map a parsed ContractError code to the bridge's normalized code. */
function fromContractErrorCode(code: ContractError["error"]["code"]): OvBridgeErrorCode {
  switch (code) {
    case "INVALID_REQUEST":
      return "REQUEST_VALIDATION_ERROR";
    case "UNAUTHORIZED":
      return "AUTHENTICATION_ERROR";
    case "FORBIDDEN":
      return "AUTHORIZATION_ERROR";
    case "PROJECT_NOT_FOUND":
      return "PROJECT_NOT_FOUND";
    case "IDEMPOTENCY_CONFLICT":
      return "IDEMPOTENCY_CONFLICT";
    case "VERSION_UNSUPPORTED":
      return "CONTRACT_VERSION_ERROR";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "INTERNAL_ERROR":
      return "INTERNAL_ERROR";
    default:
      return "INTERNAL_ERROR";
  }
}

/** Map a bare HTTP status (when no parseable ContractError body) to the bridge's normalized code. */
function fromHttpStatus(status: number): OvBridgeErrorCode {
  switch (status) {
    case 400:
      return "REQUEST_VALIDATION_ERROR";
    case 401:
      return "AUTHENTICATION_ERROR";
    case 403:
      return "AUTHORIZATION_ERROR";
    case 404:
      return "PROJECT_NOT_FOUND";
    case 409:
      return "IDEMPOTENCY_CONFLICT";
    case 422:
      return "CONTRACT_VERSION_ERROR";
    case 429:
      return "RATE_LIMITED";
    case 502:
    case 503:
    case 504:
      return "OV_UNAVAILABLE";
    default:
      return status >= 500 ? "INTERNAL_ERROR" : "INVALID_RESPONSE";
  }
}

const RETRYABLE_CODES = new Set<OvBridgeErrorCode>(["RATE_LIMITED", "OV_UNAVAILABLE", "TIMEOUT"]);

/**
 * Map an error HTTP response to a normalized bridge error. Prefers a parsed ContractError's code +
 * retryable flag; falls back to the HTTP status. Retryability is anchored to a small explicit set
 * (rate limit / unavailable / timeout) plus the contract's own retryable flag.
 */
export function mapErrorResponse(
  status: number,
  contractError: ContractError | undefined,
): MappedError {
  if (contractError) {
    const code = fromContractErrorCode(contractError.error.code);
    const retryable = contractError.error.retryable || RETRYABLE_CODES.has(code);
    return { code, retryable, message: contractError.error.message };
  }
  const code = fromHttpStatus(status);
  return { code, retryable: RETRYABLE_CODES.has(code), message: `OV returned HTTP ${status}.` };
}
