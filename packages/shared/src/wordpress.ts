/**
 * A business's own WordPress site, connected so the product can publish to it on approval
 * (issue #140, `docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md`).
 *
 * WordPress asks its owner, on a screen in their own admin, whether to give an application
 * password to the product. That password, with their user name, is the sign-in, and it is sealed
 * and kept as every other is (`docs/adr/0013-a-sign-in-is-sealed-by-the-worker.md`). No plugin
 * is installed. The flow is WordPress's own:
 * make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/, read 2026-10-14.
 */

/** The kind of allowance a plan has when it includes publishing to a WordPress site. */
export const WORDPRESS_ALLOWANCE = "wordpress";

/** What the application password is called in the owner's WordPress profile. */
export const WORDPRESS_APP_NAME = "Nearcited";

/**
 * Who the password is for, the same on every site, so WordPress can tell the product's passwords
 * from any other application's. It means nothing else.
 */
export const WORDPRESS_APP_ID = "02b7a91f-5c11-40c1-b4e7-600596981f69";

/** The page of the app WordPress sends its owner back to, approved or not. */
export const WORDPRESS_RETURN_PATH = "/wordpress/return";

/**
 * The address that asks the site's owner to approve the connection: the site's own approval
 * screen, told what to call the password and where to send them back. The `state` comes back
 * with them, which is how the app knows it started this, and `declined` says they said no.
 */
export function authorizeAddress(endpoint: string, app: string, state: string): string {
  const back = new URL(WORDPRESS_RETURN_PATH, app);
  back.searchParams.set("state", state);
  const declined = new URL(back);
  declined.searchParams.set("declined", "1");
  const address = new URL(endpoint);
  address.searchParams.set("app_name", WORDPRESS_APP_NAME);
  address.searchParams.set("app_id", WORDPRESS_APP_ID);
  address.searchParams.set("success_url", back.href);
  address.searchParams.set("reject_url", declined.href);
  return address.href;
}

/** A host as two addresses of one site are compared: lower case, without `www.`. */
const siteHost = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** Whether two addresses are on the same site, one with `www.` and one without included. */
export function sameSite(a: string, b: string): boolean {
  try {
    const one = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(a) ? a : `https://${a}`);
    const two = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(b) ? b : `https://${b}`);
    return siteHost(one.hostname) === siteHost(two.hostname);
  } catch {
    return false;
  }
}
