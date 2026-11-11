import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { TooltipProvider } from "@/components/ui/tooltip";

import "./index.css";
import { Layout } from "./layout";
import { EmailDetail } from "./pages/email-detail";
import { EmailList } from "./pages/email-list";

/** The Worker serves this app at /app and /app/messages/:token only. */
const MESSAGE_PATH = /^\/app\/messages\/(?<token>[\w-]+)\/?$/u;

const App = () => {
  const token = MESSAGE_PATH.exec(location.pathname)?.groups?.token;
  return (
    <Layout home={token === undefined}>
      {token === undefined ? <EmailList /> : <EmailDetail token={token} />}
    </Layout>
  );
};

const root = document.querySelector("#root");
if (!root) {
  throw new Error("The app requires its root element.");
}
createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>
);
