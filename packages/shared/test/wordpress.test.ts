import { describe, expect, it } from "vitest";
import { authorizeAddress, sameSite, WORDPRESS_APP_ID, WORDPRESS_APP_NAME } from "../src/wordpress";

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
