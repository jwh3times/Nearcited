import { MAILBOX_URL } from "./stack";

interface Summary {
  ID: string;
  To: { Address: string }[];
}

/**
 * The sign-in link Auth emailed to an address, read from the local stack's mail catcher. Waits
 * for the email, since it is sent after the form says it was.
 */
export async function signInLink(email: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const list = (await (await fetch(`${MAILBOX_URL}/api/v1/messages`)).json()) as {
      messages: Summary[];
    };
    const found = list.messages.find((message) =>
      message.To.some((to) => to.Address.toLowerCase() === email.toLowerCase()),
    );
    if (found) {
      const message = (await (await fetch(`${MAILBOX_URL}/api/v1/message/${found.ID}`)).json()) as {
        HTML: string;
        Text: string;
      };
      const link = /https?:\/\/[^\s"'<>)]+\/auth\/v1\/verify[^\s"'<>)]+/.exec(
        `${message.HTML}\n${message.Text}`,
      );
      if (!link) throw new Error(`The email to ${email} has no sign-in link in it.`);
      return link[0].replaceAll("&amp;", "&");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No email arrived for ${email} within 10 seconds.`);
}
