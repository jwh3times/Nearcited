import { describe, expect, it } from "vitest";
import {
  authorizeAddress,
  detailsOnPage,
  sameSite,
  WORDPRESS_APP_ID,
  WORDPRESS_APP_NAME,
  withDetails,
} from "../src/wordpress";

describe("the address that asks a site's owner to approve", () => {
  it("is the site's own screen, told what to call the password and where to send them back", () => {
    const address = new URL(
      authorizeAddress(
        "https://joes.example/wp-admin/authorize-application.php",
        "https://app.nearcited.example/locations/1",
        "the-state",
      ),
    );
    expect(address.origin + address.pathname).toBe(
      "https://joes.example/wp-admin/authorize-application.php",
    );
    expect(Object.fromEntries(address.searchParams)).toEqual({
      app_name: WORDPRESS_APP_NAME,
      app_id: WORDPRESS_APP_ID,
      success_url: "https://app.nearcited.example/wordpress/return?state=the-state",
      reject_url: "https://app.nearcited.example/wordpress/return?state=the-state&declined=1",
    });
  });
});

describe("two addresses on one site", () => {
  it("are the same host, with or without www", () => {
    expect(sameSite("https://www.joes.example/a", "joes.example")).toBe(true);
    expect(sameSite("http://JOES.example", "https://joes.example/")).toBe(true);
    expect(sameSite("https://shop.joes.example", "https://joes.example")).toBe(false);
    expect(sameSite("https://joes.example.evil", "https://joes.example")).toBe(false);
    expect(sameSite("not an address at all", "https://joes.example")).toBe(false);
  });
});

describe("the business details block on a page", () => {
  const BLOCK = '<script type="application/ld+json">\n{"name": "Joe\'s"}\n</script>';
  const OTHER = '<script type="application/ld+json">\n{"name": "Joe\'s Pizza"}\n</script>';
  const blocks = "<!-- wp:paragraph -->\n<p>Welcome.</p>\n<!-- /wp:paragraph -->";

  it("goes at the end of a block-editor page as a Custom HTML block, leaving the rest as it was", () => {
    const added = withDetails(blocks, BLOCK);
    expect(added).toBe(
      `${blocks}\n\n<!-- wp:html -->\n<!-- nearcited:details -->\n${BLOCK}\n<!-- /nearcited:details -->\n<!-- /wp:html -->`,
    );
    expect(detailsOnPage(added)).toBe(BLOCK);
    expect(detailsOnPage(blocks)).toBeNull();
  });

  it("goes onto a classic page as it is, so the rest is laid out as before", () => {
    const classic = "<p>Welcome.</p>\n\nWe make pizza.";
    const added = withDetails(classic, BLOCK);
    expect(added).toBe(
      `${classic}\n\n<!-- nearcited:details -->\n${BLOCK}\n<!-- /nearcited:details -->`,
    );
    expect(added).not.toContain("wp:html");
    expect(withDetails(added, null)).toBe(classic);
  });

  it("replaces the product's own block and nothing else, wherever the owner has written since", () => {
    const added = withDetails(blocks, BLOCK);
    const written = `${added}\n\n<!-- wp:paragraph -->\n<p>Open late.</p>\n<!-- /wp:paragraph -->`;
    const updated = withDetails(written, OTHER);
    expect(detailsOnPage(updated)).toBe(OTHER);
    expect(updated.match(/<!-- nearcited:details -->/g)).toHaveLength(1);
    expect(updated).toContain("<p>Welcome.</p>");
    expect(updated).toContain("<p>Open late.</p>");
    expect(updated.match(/<!-- wp:html -->/g)).toHaveLength(1);
  });

  it("is taken away whole, wrapping and all, leaving the page as it was", () => {
    expect(withDetails(withDetails(blocks, BLOCK), null)).toBe(blocks);
    expect(withDetails(withDetails("", BLOCK), null)).toBe("");
    expect(withDetails(blocks, null)).toBe(blocks);
  });

  it("is not found where its marks are not both there", () => {
    expect(detailsOnPage(`<!-- nearcited:details -->\n${BLOCK}`)).toBeNull();
    expect(detailsOnPage(`${BLOCK}\n<!-- /nearcited:details -->`)).toBeNull();
    expect(detailsOnPage("<!-- nearcited:details --><!-- /nearcited:details -->")).toBeNull();
  });
});
