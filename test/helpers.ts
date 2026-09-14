/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles work on untyped nodemailer versions */
import type { PostalApiResponse, PostalSendResult } from '../src/index.js';

export interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: any;
	signal: AbortSignal | null | undefined;
}

export interface FakePostal {
	fetch: typeof globalThis.fetch;
	requests: RecordedRequest[];
	/** Queue a response for the next request. Defaults to a success for every recipient. */
	respond(status: number, body: unknown): void;
	respondText(status: number, text: string): void;
}

export function successResponse(recipients: string[], messageId = 'abc-123@rp.postal.example.com') {
	const messages: PostalSendResult['messages'] = {};
	recipients.forEach((address, index) => {
		messages[address] = { id: index + 1, token: `tok${index + 1}` };
	});
	const body: PostalApiResponse<PostalSendResult> = {
		status: 'success',
		time: 0.01,
		flags: {},
		data: { message_id: messageId, messages }
	};
	return body;
}

export function errorResponse(code: string, message = `${code} happened`) {
	const body: PostalApiResponse = {
		status: 'error',
		time: 0.01,
		flags: {},
		data: { code, message }
	};
	return body;
}

function lowerHeaders(headers: RequestInit['headers'] | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!headers) return out;
	if (headers instanceof Headers) {
		headers.forEach((value, key) => {
			out[key.toLowerCase()] = value;
		});
		return out;
	}
	const entries = Array.isArray(headers) ? headers : Object.entries(headers);
	for (const [key, value] of entries) out[String(key).toLowerCase()] = String(value);
	return out;
}

/** In-memory Postal server: records requests and replies with queued responses. */
export function fakePostal(): FakePostal {
	const queue: Response[] = [];
	const requests: RecordedRequest[] = [];

	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const bodyText = typeof init?.body === 'string' ? init.body : '';
		let body: unknown;
		try {
			body = bodyText ? JSON.parse(bodyText) : undefined;
		} catch {
			body = bodyText;
		}

		requests.push({
			url,
			method: init?.method ?? 'GET',
			headers: lowerHeaders(init?.headers),
			body,
			signal: init?.signal
		});

		const queued = queue.shift();
		if (queued) return queued;

		const recipients = Array.isArray((body as any)?.rcpt_to)
			? ((body as any).rcpt_to as string[])
			: [
					...(((body as any)?.to as string[] | undefined) ?? []),
					...(((body as any)?.cc as string[] | undefined) ?? []),
					...(((body as any)?.bcc as string[] | undefined) ?? [])
				].map((address) => address.replace(/^.*<([^>]+)>$/, '$1'));

		return Response.json(successResponse(recipients));
	}) as typeof globalThis.fetch;

	return {
		fetch,
		requests,
		respond(status, body) {
			queue.push(Response.json(body, { status }));
		},
		respondText(status, text) {
			queue.push(new Response(text, { status }));
		}
	};
}

export function decodeBase64(value: string): string {
	return Buffer.from(value, 'base64').toString('utf8');
}

/** nodemailer versions under test: [label, module specifier] */
export const NODEMAILERS: Array<[label: string, specifier: string]> = [
	['nodemailer 8', 'nodemailer'],
	['nodemailer 9', 'nodemailer9'],
	['nodemailer 10', 'nodemailer10']
];

export interface NodemailerModule {
	createTransport: (transport: any, defaults?: any) => any;
}

export async function loadNodemailer(specifier: string): Promise<NodemailerModule> {
	const mod: any = await import(specifier);
	return mod.createTransport ? mod : mod.default;
}
