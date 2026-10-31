// The files with the optical-size axis, so large headings get Inter's display cut.
import "@fontsource-variable/inter/opsz.css";
// The italic is used once, for the emphasis in the sign-in headline.
import "@fontsource-variable/inter/opsz-italic.css";
import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { keepGoogleHandedBack } from "./lib/google";
import { keepHandedBack } from "./lib/wordpress";

// Before anything is drawn or fetched: WordPress sends its owner back with a password on the
// address, and Google with a code, which come off it here.
keepHandedBack();
keepGoogleHandedBack();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
