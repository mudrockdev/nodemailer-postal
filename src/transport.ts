import packageJson from '../package.json' with { type: 'json' };
import { ErrorCodes, PostalTransportError, toTransportError } from './errors.js';
import type {
	PostalApiErrorData,
	PostalApiResponse,
	PostalEnvelope,
	PostalMailMessageLike,
	PostalMessageOptions,
	PostalSendCallback,
	PostalSendMode,
	PostalSendResult,
	PostalSentMessageInfo,
	PostalTransportOptions,
	PostalVerifyCallback
} from './types.js';
import {
	contentToBase64,
	formatAddresses,
	isRecord,
	missingRecipients,
	normalizeHost,
	streamToBuffer,
	toCRLF
} from './utils.js';

const DEFAULT_TIMEOUT = 30_000;

/** Shape of `mail.data` after nodemailer's `normalize()`; only the fields used here. */
interface NormalizedMailData {
	envelope?: Partial<PostalEnvelope> | undefined;
	messageId?: string | undefined;
	from?: unknown;
	sender?: unknown;
	to?: unknown;
	cc?: unknown;
	bcc?: unknown;
	replyTo?: unknown;
	subject?: unknown;
	text?: unknown;
	html?: unknown;
	attachments?: unknown;
	normalizedHeaders?: Record<string, unknown> | undefined;
	postal?: PostalMessageOptions | undefined;
}

interface ApiCallResult<T> {
	status: number;
	body: PostalApiResponse<T>;
}

/**
 * Nodemailer transport that sends mail through the Postal HTTP API.
 *
 * ```ts
 * import nodemailer from 'nodemailer';
 * import { PostalTransport } from 'nodemailer-postal';
 *
 * const transporter = nodemailer.createTransport(
 *   new PostalTransport({ host: 'postal.example.com', apiKey: process.env.POSTAL_API_KEY! })
 * );
 * await transporter.sendMail({ from: 'me@example.com', to: 'you@example.com', subject: 'Hi', text: 'Hello' });
 * ```
 */
export class PostalTransport {
	readonly name = 'PostalTransport';
	readonly version: string = packageJson.version;

	readonly baseUrl: string;
	readonly options: Readonly<PostalTransportOptions>;

	private readonly apiKey: string;
	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly timeout: number;

	constructor(options: PostalTransportOptions) {
		if (!options || typeof options !== 'object') {
			throw new PostalTransportError(ErrorCodes.CONFIG, 'Postal transport needs an options object');
		}
		if (typeof options.host !== 'string') {
			throw new PostalTransportError(ErrorCodes.CONFIG, 'Postal transport needs a `host`');
		}
		if (typeof options.apiKey !== 'string' || !options.apiKey.trim()) {
			throw new PostalTransportError(ErrorCodes.CONFIG, 'Postal transport needs an `apiKey`');
		}
		if (options.mode !== undefined && options.mode !== 'raw' && options.mode !== 'message') {
			throw new PostalTransportError(
				ErrorCodes.CONFIG,
				`Unknown send mode "${String(options.mode)}", expected "raw" or "message"`
			);
		}

		const fetchImpl = options.fetch ?? globalThis.fetch;
		if (typeof fetchImpl !== 'function') {
			throw new PostalTransportError(
				ErrorCodes.CONFIG,
				'No fetch implementation available; pass one with the `fetch` option'
			);
		}

		this.options = { ...options };
		this.baseUrl = normalizeHost(options.host);
		this.apiKey = options.apiKey.trim();
		this.fetchImpl = fetchImpl;
		this.timeout =
			typeof options.timeout === 'number' && options.timeout >= 0
				? options.timeout
				: DEFAULT_TIMEOUT;
	}

	/** Nodemailer entry point. */
	send(mail: PostalMailMessageLike, callback: PostalSendCallback): void {
		let done = false;
		const finish: PostalSendCallback = (err, info) => {
			if (done) return;
			done = true;
			callback(err, info);
		};

		setImmediate(() => {
			this.sendMessage(mail).then(
				(info) => finish(null, info),
				(err: unknown) => finish(toTransportError(err, ErrorCodes.MESSAGE, 'Sending failed'))
			);
		});
	}

	/**
	 * Checks that the server accepts the API key by asking for a message that
	 * does not exist. Postal answers `MessageNotFound` for a valid key and
	 * `InvalidServerAPIKey` / `AccessDenied` otherwise.
	 */
	verify(): Promise<true>;
	verify(callback: PostalVerifyCallback): void;
	verify(callback?: PostalVerifyCallback): Promise<true> | void {
		const run = async (): Promise<true> => {
			const { status, body } = await this.call('messages/message', { id: 0 });
			if (body.status === 'success') return true;

			const data = isRecord(body.data) ? (body.data as PostalApiErrorData) : {};
			if (body.status === 'error' && data.code === 'MessageNotFound') return true;

			throw this.errorFromResponse(status, body);
		};

		if (!callback) return run();
		run().then(
			() => callback(null, true),
			(err: unknown) =>
				callback(toTransportError(err, ErrorCodes.CONNECTION, 'Verification failed'))
		);
	}

	private async sendMessage(mail: PostalMailMessageLike): Promise<PostalSentMessageInfo> {
		if (!mail || !mail.message) {
			throw new PostalTransportError(ErrorCodes.MESSAGE, 'Mail object has no compiled message');
		}

		const data = (mail.data ?? {}) as NormalizedMailData;
		const perMessage: PostalMessageOptions = isRecord(data.postal) ? data.postal : {};
		const mode: PostalSendMode = perMessage.mode ?? this.options.mode ?? 'raw';
		const bounce = perMessage.bounce ?? this.options.bounce ?? false;

		if (mode !== 'raw' && mode !== 'message') {
			throw new PostalTransportError(
				ErrorCodes.MESSAGE,
				`Unknown send mode "${String(mode)}", expected "raw" or "message"`
			);
		}

		const envelope = this.envelopeOf(mail);
		if (envelope.to.length === 0) {
			throw new PostalTransportError(ErrorCodes.ENVELOPE, 'Message has no recipients');
		}

		if (mode === 'raw') {
			return this.sendRaw(mail, envelope, bounce);
		}
		return this.sendStructured(mail, envelope, bounce, perMessage.tag ?? this.options.tag);
	}

	private async sendRaw(
		mail: PostalMailMessageLike,
		envelope: PostalEnvelope,
		bounce: boolean
	): Promise<PostalSentMessageInfo> {
		const message = mail.message!;
		if (!envelope.from && !bounce) {
			throw new PostalTransportError(
				ErrorCodes.ENVELOPE,
				'Message has no sender address; set `from` or `envelope.from`'
			);
		}

		const messageId = message.messageId();

		let raw: Buffer;
		try {
			raw = toCRLF(await streamToBuffer(message.createReadStream()));
		} catch (err) {
			throw toTransportError(err, ErrorCodes.MESSAGE, 'Failed to build the MIME message');
		}

		const result = await this.request<PostalSendResult>('send/raw', {
			mail_from: envelope.from || '',
			rcpt_to: envelope.to,
			data: raw.toString('base64'),
			bounce
		});

		return this.buildInfo('raw', envelope, messageId, result);
	}

	private async sendStructured(
		mail: PostalMailMessageLike,
		envelope: PostalEnvelope,
		bounce: boolean,
		tag: string | undefined
	): Promise<PostalSentMessageInfo> {
		const data = await new Promise<NormalizedMailData>((resolve, reject) => {
			mail.normalize((err: unknown, normalized?: unknown) => {
				if (err)
					return reject(
						toTransportError(err, ErrorCodes.MESSAGE, 'Failed to normalize the message')
					);
				resolve((normalized ?? {}) as NormalizedMailData);
			});
		});

		const from = formatAddresses(data.from)[0];
		const sender = formatAddresses(data.sender)[0];
		const replyTo = formatAddresses(data.replyTo);

		const attachments = Array.isArray(data.attachments)
			? data.attachments.flatMap((attachment: unknown, index: number) => {
					if (!isRecord(attachment)) return [];
					const encoded = contentToBase64(attachment.content, attachment.encoding);
					if (encoded === undefined) return [];
					return [
						{
							name:
								typeof attachment.filename === 'string' && attachment.filename
									? attachment.filename
									: `attachment-${index + 1}`,
							content_type:
								typeof attachment.contentType === 'string' && attachment.contentType
									? attachment.contentType
									: 'application/octet-stream',
							data: encoded
						}
					];
				})
			: [];

		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(data.normalizedHeaders ?? {})) {
			if (typeof value === 'string' && value) headers[key] = value;
		}

		const payload: Record<string, unknown> = {
			to: formatAddresses(data.to),
			cc: formatAddresses(data.cc),
			bcc: formatAddresses(data.bcc),
			from,
			sender,
			reply_to: replyTo.length ? replyTo.join(', ') : undefined,
			subject: typeof data.subject === 'string' ? data.subject : undefined,
			tag,
			plain_body: typeof data.text === 'string' ? data.text : undefined,
			html_body: typeof data.html === 'string' ? data.html : undefined,
			attachments: attachments.length ? attachments : undefined,
			headers: Object.keys(headers).length ? headers : undefined,
			bounce
		};

		const result = await this.request<PostalSendResult>('send/message', payload);
		return this.buildInfo('message', envelope, `<${result.message_id}>`, result);
	}

	private envelopeOf(mail: PostalMailMessageLike): PostalEnvelope {
		const data = (mail.data ?? {}) as NormalizedMailData;
		const source: Partial<PostalEnvelope> = data.envelope ?? mail.message!.getEnvelope() ?? {};
		const from = typeof source.from === 'string' && source.from ? source.from : false;
		const to = Array.isArray(source.to)
			? source.to.filter((address): address is string => typeof address === 'string' && !!address)
			: typeof source.to === 'string' && source.to
				? [source.to]
				: [];
		return { from, to };
	}

	private buildInfo(
		mode: PostalSendMode,
		envelope: PostalEnvelope,
		messageId: string,
		result: PostalSendResult
	): PostalSentMessageInfo {
		const accepted = isRecord(result.messages) ? Object.keys(result.messages) : [];
		return {
			envelope,
			messageId,
			accepted,
			rejected: missingRecipients(envelope.to, accepted),
			pending: [],
			response: typeof result.message_id === 'string' ? result.message_id : '',
			mode,
			postal: result
		};
	}

	/** Calls the API and throws unless Postal reports success. */
	private async request<T>(path: string, payload: unknown): Promise<T> {
		const { status, body } = await this.call<T>(path, payload);
		if (body.status === 'success') return body.data;
		throw this.errorFromResponse(status, body);
	}

	/** Calls the API and returns Postal's response envelope, whatever its status. */
	private async call<T>(path: string, payload: unknown): Promise<ApiCallResult<T>> {
		const url = `${this.baseUrl}/api/v1/${path}`;
		const headers: Record<string, string> = {
			...(this.options.headers ?? {}),
			'content-type': 'application/json',
			accept: 'application/json',
			'x-server-api-key': this.apiKey
		};

		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(payload),
				signal: this.timeout > 0 ? AbortSignal.timeout(this.timeout) : undefined
			});
		} catch (err) {
			const timedOut =
				err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
			throw new PostalTransportError(
				timedOut ? ErrorCodes.TIMEOUT : ErrorCodes.CONNECTION,
				timedOut
					? `Request to ${url} timed out after ${this.timeout}ms`
					: `Request to ${url} failed${err instanceof Error && err.message ? `: ${err.message}` : ''}`,
				{ cause: err }
			);
		}

		const text = await response.text();
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			parsed = undefined;
		}

		if (!isRecord(parsed) || typeof parsed.status !== 'string') {
			if (!response.ok) {
				throw new PostalTransportError(
					ErrorCodes.HTTP,
					`Postal responded with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
					{ status: response.status, response: text }
				);
			}
			throw new PostalTransportError(
				ErrorCodes.RESPONSE,
				'Postal returned an unexpected response',
				{
					status: response.status,
					response: text
				}
			);
		}

		return { status: response.status, body: parsed as unknown as PostalApiResponse<T> };
	}

	private errorFromResponse(
		status: number,
		body: PostalApiResponse<unknown>
	): PostalTransportError {
		const data = isRecord(body.data) ? (body.data as PostalApiErrorData) : {};
		const fallbackCode =
			body.status === 'parameter-error' ? ErrorCodes.PARAMETER : ErrorCodes.POSTAL;
		const code = typeof data.code === 'string' && data.code ? data.code : fallbackCode;
		const message =
			typeof data.message === 'string' && data.message
				? data.message
				: `Postal returned status "${body.status}"`;
		return new PostalTransportError(code, message, { status, response: body });
	}
}

/** Convenience factory, same as `new PostalTransport(options)`. */
export function createPostalTransport(options: PostalTransportOptions): PostalTransport {
	return new PostalTransport(options);
}
