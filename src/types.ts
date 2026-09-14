/* eslint-disable @typescript-eslint/no-explicit-any -- loose on purpose, see PostalMailMessageLike */
import type { Readable } from 'node:stream';

/**
 * How a message is handed to Postal.
 *
 * - `raw`: nodemailer builds the full RFC 2822 message and it is posted to
 *   `/api/v1/send/raw`. Everything nodemailer supports (alternatives, inline
 *   images, calendar events, custom headers, DKIM, ...) is preserved. Default.
 * - `message`: the message fields are posted to `/api/v1/send/message` and
 *   Postal builds the MIME message itself. Postal then records the subject,
 *   tag and bodies separately, but inline (`cid`) images, `alternatives`,
 *   `amp`, `watchHtml` and `icalEvent` cannot be represented.
 */
export type PostalSendMode = 'raw' | 'message';

/** Options shared by every message sent through the transport. */
export interface PostalTransportOptions {
	/**
	 * Postal server address. A bare hostname (`postal.example.com`) is treated
	 * as HTTPS; a full URL (`http://localhost:5000`) is used as given.
	 */
	host: string;
	/** Server API key from the Postal web interface (`X-Server-API-Key`). */
	apiKey: string;
	/** Send mode, defaults to `raw`. Can be overridden per message. */
	mode?: PostalSendMode | undefined;
	/** Default `tag` for messages sent in `message` mode. */
	tag?: string | undefined;
	/** Mark messages as bounces by default. */
	bounce?: boolean | undefined;
	/** Request timeout in milliseconds, defaults to 30000. `0` disables it. */
	timeout?: number | undefined;
	/** Custom `fetch` implementation (proxies, custom agents, tests). Defaults to `globalThis.fetch`. */
	fetch?: typeof globalThis.fetch | undefined;
	/** Extra HTTP headers added to every API request. */
	headers?: Record<string, string> | undefined;
}

/** Per message overrides, passed as the `postal` field of `sendMail()` options. */
export interface PostalMessageOptions {
	/** Postal tag, only used in `message` mode. */
	tag?: string | undefined;
	/** Mark this message as a bounce. */
	bounce?: boolean | undefined;
	/** Send mode for this message. */
	mode?: PostalSendMode | undefined;
}

/**
 * Helper to add the `postal` field to nodemailer's send options without an
 * excess property error:
 *
 * ```ts
 * const options: PostalMailOptions<SendMailOptions> = { to, subject, postal: { tag: 'welcome' } };
 * ```
 */
export type PostalMailOptions<T = Record<string, unknown>> = T & {
	postal?: PostalMessageOptions | undefined;
};

/** Envelope the message was sent with. */
export interface PostalEnvelope {
	from: string | false;
	to: string[];
	/** Custom envelope fields preserved by nodemailer. */
	[key: string]: unknown;
}

/** `data` of a successful `send/raw` or `send/message` response. */
export interface PostalSendResult {
	/** Postal's own message id, without angle brackets. */
	message_id: string;
	/** One entry per recipient Postal accepted. */
	messages: Record<string, PostalRecipientMessage>;
	[key: string]: unknown;
}

export interface PostalRecipientMessage {
	id: number;
	token: string;
	[key: string]: unknown;
}

/** `data` of an error response. */
export interface PostalApiErrorData {
	code?: string | undefined;
	message?: string | undefined;
	[key: string]: unknown;
}

/** Envelope Postal wraps every API response in. */
export interface PostalApiResponse<T = unknown> {
	status: 'success' | 'error' | 'parameter-error';
	time?: number | undefined;
	flags?: Record<string, unknown> | undefined;
	data: T;
}

/** What `sendMail()` resolves with. */
export interface PostalSentMessageInfo {
	envelope: PostalEnvelope;
	/**
	 * Message-ID of the sent message, with angle brackets.
	 * In `raw` mode this is the id nodemailer wrote into the headers; in
	 * `message` mode Postal generates the header, so this is Postal's id.
	 */
	messageId: string;
	/** Recipients Postal accepted. */
	accepted: string[];
	/** Envelope recipients missing from Postal's response. */
	rejected: string[];
	pending: string[];
	/** Postal's message id, as returned by the API. */
	response: string;
	/** Send mode that was used. */
	mode: PostalSendMode;
	/** Full `data` object of the Postal response. */
	postal: PostalSendResult;
	[key: string]: unknown;
}

/** The parts of nodemailer's MimeNode the transport relies on. */
export interface PostalMimeNodeLike {
	createReadStream(...args: any[]): Readable;
	getEnvelope(): any;
	messageId(): string;
}

/**
 * The parts of nodemailer's MailMessage the transport relies on. Kept loose on
 * purpose so the same build type checks against nodemailer 8, 9 and 10.
 */
export interface PostalMailMessageLike {
	data: any;
	message: PostalMimeNodeLike | null;
	normalize(callback: (err: any, data?: any) => void): void;
}

/** Callback nodemailer hands to `Transport.send()`. */
export type PostalSendCallback = (err: Error | null, info?: PostalSentMessageInfo) => void;

/** Callback nodemailer hands to `Transport.verify()`. */
export type PostalVerifyCallback = (err: Error | null, success?: true) => void;
