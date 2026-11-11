import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { TooltipProvider } from "@/components/ui/tooltip";

import "./index.css";
import { Layout } from "./layout";
import { EmailDetail } from "./pages/email-detail";
import { EmailList } from "./pages/email-list";
import { PeopleList } from "./pages/people-list";
import { PersonPage } from "./pages/person";

/** The Worker serves this app at /app, /app/messages/:token, /app/people and /app/people/:address. */
const MESSAGE_PATH = /^\/app\/messages\/(?<token>[\w-]+)\/?$/u;
const PEOPLE_PATH = /^\/app\/people\/?$/u;
const PERSON_PATH = /^\/app\/people\/(?<address>[^/]+)\/?$/u;

/** A percent-encoded path segment; null when it is not valid encoding. */
const decoded = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

const Page = ({ path }: { path: string }) => {
  const token = MESSAGE_PATH.exec(path)?.groups?.token;
  if (token !== undefined) {
    return (
      <Layout current="emails" home={false}>
        <EmailDetail token={token} />
      </Layout>
    );
  }
  if (PEOPLE_PATH.test(path)) {
    return (
      <Layout current="people" home>
        <PeopleList />
      </Layout>
    );
  }
  const segment = PERSON_PATH.exec(path)?.groups?.address;
  const address = segment === undefined ? null : decoded(segment);
  if (address !== null) {
    return (
      <Layout current="people" home={false}>
        <PersonPage address={address} />
      </Layout>
    );
  }
  return (
    <Layout current="emails" home>
      <EmailList />
    </Layout>
  );
};

const App = () => <Page path={location.pathname} />;

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
