/**
 * Compile-time only: checked by `bun run typecheck`, never executed.
 * Makes sure the transport is accepted by `createTransport` under both the
 * @types/nodemailer typings (nodemailer 8 / 9) and nodemailer 10's own types.
 */
import {
	createTransport as createTransport8,
	type SendMailOptions as SendMailOptions8
} from 'nodemailer';
import {
	createTransport as createTransport10,
	type SendMailOptions as SendMailOptions10
} from 'nodemailer10';
import {
	PostalTransport,
	type PostalMailOptions,
	type PostalSentMessageInfo
} from '../src/index.js';

const transport = new PostalTransport({ host: 'postal.example.com', apiKey: 'key' });

export async function withNodemailer8(): Promise<string> {
	const transporter = createTransport8(transport);
	const options: PostalMailOptions<SendMailOptions8> = {
		from: 'a@example.com',
		to: 'b@example.com',
		text: 'hi',
		postal: { tag: 'welcome' }
	};
	// @types/nodemailer types every custom transport's result as the SMTP result,
	// so the Postal specific fields need a cast on nodemailer 8 / 9.
	const info = (await transporter.sendMail(options)) as unknown as PostalSentMessageInfo;
	await transporter.verify();
	return info.postal.message_id;
}

export async function withNodemailer10(): Promise<string> {
	const transporter = createTransport10(transport);
	const options: PostalMailOptions<SendMailOptions10> = {
		from: 'a@example.com',
		to: 'b@example.com',
		text: 'hi',
		postal: { mode: 'message' }
	};
	// nodemailer 10 ships its own types and infers the Postal result type.
	const info: PostalSentMessageInfo = await transporter.sendMail(options);
	await transporter.verify();
	return info.postal.message_id;
}
