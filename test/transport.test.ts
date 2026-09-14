/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles work on untyped nodemailer versions */
import { describe, expect, test } from 'bun:test';
import {
	ErrorCodes,
	PostalTransport,
	PostalTransportError,
	createPostalTransport
} from '../src/index.js';
import {
	NODEMAILERS,
	decodeBase64,
	errorResponse,
	fakePostal,
	loadNodemailer,
	successResponse
} from './helpers.js';

const HOST = 'postal.example.com';
const API_KEY = 'server-api-key';

describe.each(NODEMAILERS)('%s', (_label, specifier) => {
	const transporterFor = async (postal = fakePostal(), extra: Record<string, unknown> = {}) => {
		const nodemailer = await loadNodemailer(specifier);
		const transport = new PostalTransport({
			host: HOST,
			apiKey: API_KEY,
			fetch: postal.fetch,
			...extra
		});
		return { postal, transport, transporter: nodemailer.createTransport(transport) };
	};

	test('sends the raw MIME message to /send/raw by default', async () => {
		const { postal, transporter } = await transporterFor();

		const info = await transporter.sendMail({
			from: 'Sender Name <sender@example.com>',
			to: ['alice@example.com', 'Bob <bob@example.com>'],
			cc: 'carol@example.com',
			subject: 'Hello there',
			text: 'plain body',
			html: '<p>html body</p>',
			attachments: [{ filename: 'note.txt', content: 'attached text' }]
		});

		expect(postal.requests).toHaveLength(1);
		const request = postal.requests[0]!;
		expect(request.url).toBe('https://postal.example.com/api/v1/send/raw');
		expect(request.method).toBe('POST');
		expect(request.headers['x-server-api-key']).toBe(API_KEY);
		expect(request.headers['content-type']).toBe('application/json');

		expect(request.body.mail_from).toBe('sender@example.com');
		expect(request.body.rcpt_to).toEqual([
			'alice@example.com',
			'bob@example.com',
			'carol@example.com'
		]);
		expect(request.body.bounce).toBe(false);

		const mime = decodeBase64(request.body.data);
		expect(mime).toContain('Subject: Hello there');
		expect(mime).toContain('From: Sender Name <sender@example.com>');
		expect(mime).toContain('plain body');
		expect(mime).toContain('<p>html body</p>');
		expect(mime).toContain('filename=note.txt');
		// Every line ending must be CRLF
		expect(mime.replace(/\r\n/g, '')).not.toContain('\n');

		expect(info.mode).toBe('raw');
		expect(info.messageId).toMatch(/^<.+@.+>$/);
		expect(mime).toContain(`Message-ID: ${info.messageId}`);
		expect(info.envelope).toEqual({
			from: 'sender@example.com',
			to: ['alice@example.com', 'bob@example.com', 'carol@example.com']
		});
		expect(info.accepted).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
		expect(info.rejected).toEqual([]);
		expect(info.response).toBe('abc-123@rp.postal.example.com');
		expect(info.postal.messages['alice@example.com']).toEqual({ id: 1, token: 'tok1' });
	});

	test('honours a custom envelope in raw mode', async () => {
		const { postal, transporter } = await transporterFor();

		await transporter.sendMail({
			from: 'sender@example.com',
			to: 'alice@example.com',
			envelope: { from: 'bounces@example.com', to: ['real@example.com'] },
			text: 'x'
		});

		expect(postal.requests[0]!.body.mail_from).toBe('bounces@example.com');
		expect(postal.requests[0]!.body.rcpt_to).toEqual(['real@example.com']);
	});

	test('sends structured fields to /send/message in message mode', async () => {
		const { postal, transporter } = await transporterFor(fakePostal(), {
			mode: 'message',
			tag: 'default-tag'
		});

		const info = await transporter.sendMail({
			from: { name: 'Sender "Quoted"', address: 'sender@example.com' },
			sender: 'actual@example.com',
			to: ['alice@example.com', 'Bob <bob@example.com>'],
			cc: 'carol@example.com',
			bcc: 'dave@example.com',
			replyTo: ['reply@example.com', 'Other <other@example.com>'],
			subject: 'Structured',
			text: 'plain body',
			html: Buffer.from('<p>buffer html</p>'),
			headers: { 'X-Custom': 'yes', 'X-Empty': '' },
			attachments: [
				{ filename: 'note.txt', content: 'attached text', contentType: 'text/plain' },
				{ filename: 'bin.dat', content: Buffer.from([1, 2, 3]) },
				{ content: 'aGV4', encoding: 'base64', contentType: 'application/octet-stream' }
			]
		});

		const request = postal.requests[0]!;
		expect(request.url).toBe('https://postal.example.com/api/v1/send/message');
		expect(request.body).toMatchObject({
			from: '"Sender \\"Quoted\\"" <sender@example.com>',
			sender: 'actual@example.com',
			to: ['alice@example.com', '"Bob" <bob@example.com>'],
			cc: ['carol@example.com'],
			bcc: ['dave@example.com'],
			reply_to: 'reply@example.com, "Other" <other@example.com>',
			subject: 'Structured',
			tag: 'default-tag',
			plain_body: 'plain body',
			html_body: '<p>buffer html</p>',
			headers: { 'X-Custom': 'yes' },
			bounce: false
		});
		expect(request.body.headers).not.toHaveProperty('X-Empty');
		expect(request.body.attachments).toEqual([
			{
				name: 'note.txt',
				content_type: 'text/plain',
				data: Buffer.from('attached text').toString('base64')
			},
			{
				name: 'bin.dat',
				content_type: 'application/octet-stream',
				data: Buffer.from([1, 2, 3]).toString('base64')
			},
			{
				// nodemailer names unnamed attachments itself: `attachment-<n>.<ext from content type>`
				name: expect.stringMatching(/^attachment-3\./),
				content_type: 'application/octet-stream',
				data: 'aGV4'
			}
		]);

		expect(info.mode).toBe('message');
		expect(info.messageId).toBe('<abc-123@rp.postal.example.com>');
		expect(info.accepted).toEqual([
			'alice@example.com',
			'bob@example.com',
			'carol@example.com',
			'dave@example.com'
		]);
	});

	test('per message `postal` options override the transport defaults', async () => {
		const { postal, transporter } = await transporterFor(fakePostal(), { tag: 'default-tag' });

		await transporter.sendMail({
			from: 'sender@example.com',
			to: 'alice@example.com',
			text: 'x',
			postal: { mode: 'message', tag: 'welcome', bounce: true }
		});

		const request = postal.requests[0]!;
		expect(request.url).toBe('https://postal.example.com/api/v1/send/message');
		expect(request.body.tag).toBe('welcome');
		expect(request.body.bounce).toBe(true);
	});

	test('reports recipients Postal did not list as rejected', async () => {
		const postal = fakePostal();
		postal.respond(200, successResponse(['alice@example.com']));
		const { transporter } = await transporterFor(postal);

		const info = await transporter.sendMail({
			from: 'sender@example.com',
			to: ['alice@example.com', 'bob@example.com'],
			text: 'x'
		});

		expect(info.accepted).toEqual(['alice@example.com']);
		expect(info.rejected).toEqual(['bob@example.com']);
	});

	test('rejects with Postal error codes', async () => {
		const postal = fakePostal();
		postal.respond(
			200,
			errorResponse('UnauthenticatedFromAddress', 'The From address is not authorised')
		);
		const { transporter } = await transporterFor(postal);

		const err: unknown = await transporter
			.sendMail({ from: 'nope@other.com', to: 'alice@example.com', text: 'x' })
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(PostalTransportError);
		const transportError = err as PostalTransportError;
		expect(transportError.code).toBe('UnauthenticatedFromAddress');
		expect(transportError.message).toBe('The From address is not authorised');
		expect(transportError.status).toBe(200);
	});

	test('rejects parameter errors', async () => {
		const postal = fakePostal();
		postal.respond(200, { status: 'parameter-error', data: { message: 'rcpt_to is missing' } });
		const { transporter } = await transporterFor(postal);

		const err = (await transporter
			.sendMail({ from: 'a@example.com', to: 'b@example.com', text: 'x' })
			.catch((e: unknown) => e)) as PostalTransportError;

		expect(err.code).toBe(ErrorCodes.PARAMETER);
		expect(err.message).toBe('rcpt_to is missing');
	});

	test('rejects non-JSON HTTP failures with the status code', async () => {
		const postal = fakePostal();
		postal.respondText(502, '<html>Bad Gateway</html>');
		const { transporter } = await transporterFor(postal);

		const err = (await transporter
			.sendMail({ from: 'a@example.com', to: 'b@example.com', text: 'x' })
			.catch((e: unknown) => e)) as PostalTransportError;

		expect(err.code).toBe(ErrorCodes.HTTP);
		expect(err.status).toBe(502);
		expect(err.response).toBe('<html>Bad Gateway</html>');
	});

	test('rejects when there are no recipients', async () => {
		const { postal, transporter } = await transporterFor();

		const err = (await transporter
			.sendMail({ from: 'a@example.com', subject: 'no one', text: 'x' })
			.catch((e: unknown) => e)) as PostalTransportError;

		expect(err.code).toBe(ErrorCodes.ENVELOPE);
		expect(postal.requests).toHaveLength(0);
	});

	test('verify resolves for a valid key and rejects for an invalid one', async () => {
		const postal = fakePostal();
		postal.respond(200, errorResponse('MessageNotFound'));
		postal.respond(200, errorResponse('InvalidServerAPIKey', 'The API key is invalid'));
		const { transporter } = await transporterFor(postal);

		await expect(transporter.verify()).resolves.toBe(true);
		expect(postal.requests[0]!.url).toBe('https://postal.example.com/api/v1/messages/message');
		expect(postal.requests[0]!.headers['x-server-api-key']).toBe(API_KEY);

		const err = (await transporter.verify().catch((e: unknown) => e)) as PostalTransportError;
		expect(err.code).toBe('InvalidServerAPIKey');
	});
});

describe('PostalTransport options', () => {
	test('normalizes the host', () => {
		expect(new PostalTransport({ host: 'postal.example.com', apiKey: 'k' }).baseUrl).toBe(
			'https://postal.example.com'
		);
		expect(new PostalTransport({ host: 'https://postal.example.com/', apiKey: 'k' }).baseUrl).toBe(
			'https://postal.example.com'
		);
		expect(
			new PostalTransport({ host: 'http://localhost:5000/postal/', apiKey: 'k' }).baseUrl
		).toBe('http://localhost:5000/postal');
		expect(createPostalTransport({ host: 'postal.example.com', apiKey: 'k' })).toBeInstanceOf(
			PostalTransport
		);
	});

	test('rejects bad configuration', () => {
		expect(() => new PostalTransport({ host: '', apiKey: 'k' })).toThrow(PostalTransportError);
		expect(() => new PostalTransport({ host: 'postal.example.com', apiKey: '' })).toThrow(
			PostalTransportError
		);
		expect(() => new PostalTransport({ host: 'ftp://postal.example.com', apiKey: 'k' })).toThrow(
			PostalTransportError
		);
		expect(
			() => new PostalTransport({ host: 'postal.example.com', apiKey: 'k', mode: 'smtp' as any })
		).toThrow(PostalTransportError);
	});

	test('exposes name and version for nodemailer', () => {
		const transport = new PostalTransport({ host: 'postal.example.com', apiKey: 'k' });
		expect(transport.name).toBe('PostalTransport');
		expect(transport.version).toMatch(/^\d+\.\d+\.\d+/);
	});

	test('adds custom headers and aborts on timeout', async () => {
		const postal = fakePostal();
		const nodemailer = await loadNodemailer('nodemailer');
		const transporter = nodemailer.createTransport(
			new PostalTransport({
				host: 'postal.example.com',
				apiKey: 'k',
				headers: { 'x-trace': 'abc' },
				fetch: postal.fetch
			})
		);

		await transporter.sendMail({ from: 'a@example.com', to: 'b@example.com', text: 'x' });
		expect(postal.requests[0]!.headers['x-trace']).toBe('abc');
		expect(postal.requests[0]!.signal).toBeInstanceOf(AbortSignal);

		const hanging = nodemailer.createTransport(
			new PostalTransport({
				host: 'postal.example.com',
				apiKey: 'k',
				timeout: 20,
				fetch: ((_url: unknown, init?: RequestInit) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
					})) as typeof globalThis.fetch
			})
		);

		const err = (await hanging
			.sendMail({ from: 'a@example.com', to: 'b@example.com', text: 'x' })
			.catch((e: unknown) => e)) as PostalTransportError;
		expect(err.code).toBe(ErrorCodes.TIMEOUT);
	});

	test('wraps network failures', async () => {
		const nodemailer = await loadNodemailer('nodemailer');
		const transporter = nodemailer.createTransport(
			new PostalTransport({
				host: 'postal.example.com',
				apiKey: 'k',
				fetch: (() =>
					Promise.reject(new TypeError('fetch failed'))) as unknown as typeof globalThis.fetch
			})
		);

		const err = (await transporter
			.sendMail({ from: 'a@example.com', to: 'b@example.com', text: 'x' })
			.catch((e: unknown) => e)) as PostalTransportError;
		expect(err.code).toBe(ErrorCodes.CONNECTION);
		expect(err.message).toContain('fetch failed');
	});
});
