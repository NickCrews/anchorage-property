/**
 * SQL string-literal quoting — the one definition behind every module that
 * builds SQL by interpolation. The helper returns the complete literal,
 * wrapping quotes included, so a call site can't escape and then forget the
 * quotes (or vice versa).
 */

/** Quote a string as a SQL string literal. */
export const sqlStr = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** SQL IN-list from a catalog of string values. */
export const sqlList = (values: readonly string[]) => values.map(sqlStr).join(", ");
