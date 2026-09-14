/**
 * Error codes the transport produces itself. Errors reported by Postal carry
 * Postal's own code instead (`UnauthenticatedFromAddress`, `NoRecipients`,
 * `InvalidServerAPIKey`, `AccessDenied`, ...).
 */
export const ErrorCodes = {
	/** Transport constructed with missing or invalid options. */
	CONFIG: 'ECONFIG',
	/** nodemailer failed to build the message. */
	MESSAGE: 'EMESSAGE',
	/** Envelope has no recipients or (in raw mode) no sender. */
	ENVELOPE: 'EENVELOPE',
	/** The HTTP request could not be made. */
	CONNECTION: 'ECONNECTION',
	/** The HTTP request timed out. */
	TIMEOUT: 'ETIMEDOUT',
	/** Postal answered with a non-2xx status and no parsable error body. */
	HTTP: 'EHTTP',
	/** Postal's response was not the expected JSON envelope. */
	RESPONSE: 'ERESPONSE',
	/** Postal rejected the request parameters (`status: "parameter-error"`). */
	PARAMETER: 'EPARAMETER',
	/** Postal reported an error without a code. */
	POSTAL: 'EPOSTAL'
} as const;

export type TransportErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface PostalTransportErrorDetails {
	/** HTTP status of the response, if one was received. */
	status?: number | undefined;
	/** Parsed response body, or the raw text when it was not JSON. */
	response?: unknown;
	/** Underlying error. */
	cause?: unknown;
}

/**
 * Error raised by the transport. `code` is either one of {@link ErrorCodes}
 * or the error code Postal returned.
 */
export class PostalTransportError extends Error {
	override readonly name = 'PostalTransportError';
	readonly code: string;
	readonly status: number | undefined;
	readonly response: unknown;

	constructor(code: string, message: string, details: PostalTransportErrorDetails = {}) {
		super(message, details.cause === undefined ? undefined : { cause: details.cause });
		this.code = code;
		this.status = details.status;
		this.response = details.response;
	}
}

/** Wraps anything thrown into a PostalTransportError, leaving existing ones untouched. */
export function toTransportError(
	err: unknown,
	code: string,
	message: string
): PostalTransportError {
	if (err instanceof PostalTransportError) return err;
	const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
	return new PostalTransportError(code, `${message}${detail}`, { cause: err });
}
