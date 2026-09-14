/**
 * `nodemailer9` is an npm alias of nodemailer 9, which ships no types.
 * Its API matches the @types/nodemailer 8 typings closely enough for the tests.
 * `nodemailer10` ships its own types and needs no shim.
 */
declare module 'nodemailer9' {
	export * from 'nodemailer';
}
