import { z } from "zod";

export const MAX_ACL_PRINCIPALS = 1_000;

export const MAX_ACL_PRINCIPAL_CHARS = 256;

export const aclPrincipalSchema = z
	.string()
	.trim()
	.min(1, { message: "acl principals cannot be blank" })
	.max(MAX_ACL_PRINCIPAL_CHARS, {
		message: `acl principals must be at most ${MAX_ACL_PRINCIPAL_CHARS} characters`,
	});

export const ingestAclSchema = z
	.array(aclPrincipalSchema)
	.min(1, {
		message:
			'acl must name at least one principal. To make the item private send ["__private__"]; ' +
			"to leave it unrestricted omit acl.",
	})
	.max(MAX_ACL_PRINCIPALS, {
		message: `acl must contain at most ${MAX_ACL_PRINCIPALS} principals`,
	});
