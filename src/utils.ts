import type { Readable } from 'node:stream';
import { ErrorCodes, PostalTransportError } from './errors.js';

/**
 * Turns `postal.example.com`, `https://postal.example.com/` or
 * `http://localhost:5000` into a base URL without a trailing slash.
 */
export function normalizeHost(host: string): string {
	const trimmed = host.trim();
	if (!trimmed) {
		throw new PostalTransportError(ErrorCodes.CONFIG, 'Postal transport needs a `host`');
	}

	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

	let url: URL;
	try {
		url = new URL(withScheme);
	} catch (err) {
		throw new PostalTransportError(ErrorCodes.CONFIG, `Invalid Postal host: ${host}`, {
			cause: err
		});
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new PostalTransportError(
			ErrorCodes.CONFIG,
			`Postal host must use http or https, got ${url.protocol.slice(0, -1)}`
		);
	}

	return url.origin + url.pathname.replace(/\/+$/, '');
}

/** Collects a readable stream into a single Buffer. */
export function streamToBuffer(stream: Readable): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on('data', (chunk: Buffer | string) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		stream.once('error', reject);
		stream.once('end', () => resolve(Buffer.concat(chunks)));
	});
}

/** Rewrites lone `\n` line endings to `\r\n` as RFC 2822 requires. */
export function toCRLF(input: Buffer): Buffer {
	let missing = 0;
	for (let i = 0; i < input.length; i++) {
		if (input[i] === 0x0a && (i === 0 || input[i - 1] !== 0x0d)) missing++;
	}
	if (missing === 0) return input;

	const out = Buffer.allocUnsafe(input.length + missing);
	let j = 0;
	for (let i = 0; i < input.length; i++) {
		const byte = input[i] as number;
		if (byte === 0x0a && (i === 0 || input[i - 1] !== 0x0d)) out[j++] = 0x0d;
		out[j++] = byte;
	}
	return out;
}

interface AddressObject {
	name?: string | undefined;
	address?: string | undefined;
	group?: unknown;
}

/**
 * Formats a nodemailer address object (`{ name, address }`) as
 * `"Name" <address>`. Address groups are flattened. Anything without an
 * address is dropped.
 */
export function formatAddresses(value: unknown): string[] {
	if (value === null || value === undefined || value === false) return [];
	if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
	if (Array.isArray(value)) return value.flatMap((entry) => formatAddresses(entry));
	if (typeof value !== 'object') return [];

	const entry = value as AddressObject;
	if (Array.isArray(entry.group)) return formatAddresses(entry.group);

	const address = typeof entry.address === 'string' ? entry.address.trim() : '';
	if (!address) return [];

	const name = typeof entry.name === 'string' ? entry.name.trim() : '';
	if (!name) return [address];

	return [`"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`];
}

/** Base64 encodes attachment content as nodemailer's `normalize()` leaves it. */
export function contentToBase64(content: unknown, encoding: unknown): string | undefined {
	if (content === null || content === undefined) return undefined;
	if (Buffer.isBuffer(content)) return content.toString('base64');
	if (content instanceof Uint8Array) return Buffer.from(content).toString('base64');
	if (typeof content !== 'string') return undefined;
	if (encoding === 'base64') return content;

	const enc = typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8';
	return Buffer.from(content, enc).toString('base64');
}

/** Case-insensitive set difference used to work out rejected recipients. */
export function missingRecipients(wanted: string[], got: string[]): string[] {
	const seen = new Set(got.map((address) => address.toLowerCase()));
	return wanted.filter((address) => !seen.has(address.toLowerCase()));
}

/** `true` for plain objects, used to validate JSON responses. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
