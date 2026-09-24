/** Normalize line breaks and remove C0/C1 terminal controls, keeping tabs and newlines. */
export function stripControlCharacters(text) {
    return (text
        .replace(/\r\n?/g, "\n")
        // oxlint-disable-next-line eslint/no-control-regex -- SAFETY: Display text permits tabs/newlines but no other C0/C1 terminal controls.
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ""));
}
