import { useState } from "react";
import type { ComponentProps } from "react";
import { Avatar } from "../src/components/avatar";
import { CodeBlock } from "../src/components/code-block";
import { DescriptionList } from "../src/components/description-list";
import { Field } from "../src/components/field";
import { Link } from "../src/components/link";
import { Pagination } from "../src/components/pagination";
import { RadioGroup } from "../src/components/radio-group";
import { SegmentedControl } from "../src/components/segmented-control";
import { SensitiveInput } from "../src/components/sensitive-input";
import { Row, Section } from "./parts";

/** Stands in for a router's link component: the adapter hands it the element and ikada merges its props. */
function RouterLink({ to, ...props }: ComponentProps<"a"> & { to: string }) {
  return <a href={`#${to}`} {...props} />;
}

const themes = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The pieces the Community dashboard needs on top of the first batch. */
export function AppPiecesSection() {
  const [theme, setTheme] = useState("system");
  const [page, setPage] = useState(6);
  const [retention, setRetention] = useState("30");
  return (
    <Section
      title="Account and app pieces"
      hint="Avatar, SegmentedControl, RadioGroup, SensitiveInput, DescriptionList, Pagination, CodeBlock and the router link adapter."
    >
      <Row label="Link with render: the router's element wears the ikada styles (here a stand-in for TanStack's Link)">
        <Link render={<RouterLink to="/projects" />}>Sprouts</Link>
        <Link href="https://sproutboat.com" external>
          Documentation
        </Link>
      </Row>
      <Row label="Avatar: image that fails to load, no image, three sizes">
        <Avatar name="andrea" src="/does-not-exist.png" />
        <Avatar name="test-admin" size="sm" />
        <Avatar name="member" />
        <Avatar name="deletable" size="lg" />
      </Row>
      <Row label="SegmentedControl: a click on the selected segment keeps it selected; arrow keys move">
        <div className="w-full max-w-xs">
          <SegmentedControl aria-label="Theme" options={themes} value={theme} onValueChange={setTheme} />
        </div>
        <div className="w-full max-w-[12rem]">
          <SegmentedControl
            aria-label="Density"
            size="sm"
            options={themes.slice(0, 2)}
            value="light"
            onValueChange={() => {}}
          />
        </div>
      </Row>
      <Row label="RadioGroup: vertical with a description, horizontal, disabled option, invalid">
        <RadioGroup
          legend="Log retention"
          value={retention}
          onValueChange={(v) => setRetention(String(v))}
          options={[
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days", description: "Recommended" },
            { value: "90", label: "90 days", disabled: true },
          ]}
        />
        <RadioGroup
          legend="Runtime"
          orientation="horizontal"
          defaultValue="a"
          options={[
            { value: "a", label: "One" },
            { value: "b", label: "Two" },
          ]}
        />
        <RadioGroup
          legend="Required choice"
          invalid
          options={[
            { value: "a", label: "One" },
            { value: "b", label: "Two" },
          ]}
        />
      </Row>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Password" description="Masked until you reveal it.">
          <SensitiveInput autoComplete="current-password" defaultValue="correct horse battery" />
        </Field>
        <Field label="CLI token" description="Copy works while it is masked.">
          <SensitiveInput readOnly copyable defaultValue="sproutboat_9f2c41d0a7e84b6c" mono />
        </Field>
        <Field label="Revealed" description="Starts revealed.">
          <SensitiveInput defaultRevealed copyable defaultValue="sproutboat_9f2c41d0a7e84b6c" mono />
        </Field>
        <Field label="Password (invalid)" error="Use at least 12 characters.">
          <SensitiveInput defaultValue="short" />
        </Field>
      </div>
      <Row label="DescriptionList: inline (side by side from 32rem of its own width) and stacked">
        <div className="grid w-full gap-4 lg:grid-cols-2">
          <div className="rounded-xl bg-surface p-4 shadow-card">
            <DescriptionList
              items={[
                { id: "username", term: "Username", details: "test-admin" },
                { id: "email", term: "Email", details: "admin@example.test" },
                { id: "project", term: "Project id", details: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", mono: true },
              ]}
            />
          </div>
          <div className="rounded-xl bg-surface p-4 shadow-card">
            <DescriptionList
              layout="stacked"
              items={[
                { id: "hostname", term: "Hostname", details: "blog.test-admin.sproutboat.localhost", mono: true },
                { id: "version", term: "Active version", details: "v3" },
              ]}
            />
          </div>
        </div>
      </Row>
      <Row label="Pagination: full with gaps, compact, first page, single page">
        <div className="flex w-full flex-col items-start gap-3">
          <Pagination page={page} pageCount={12} onPageChange={setPage} />
          <Pagination compact page={page} pageCount={12} onPageChange={setPage} />
          <Pagination page={1} pageCount={3} onPageChange={() => {}} />
          <Pagination page={1} pageCount={1} onPageChange={() => {}} />
        </div>
      </Row>
      <Row label="CodeBlock: copy, long line scrolls, wrapped">
        <div className="grid w-full gap-3 lg:grid-cols-2">
          <CodeBlock label="Deploy command" code={"sproutboat init hello\nsproutboat login\nsproutboat deploy hello"} />
          <CodeBlock
            label="Long output"
            code="curl -sS https://hello.test-admin.sproutboat.localhost/api/items?limit=100&cursor=eyJpZCI6MTIzfQ -H 'accept: application/json'"
          />
          <CodeBlock
            wrap
            copyable={false}
            label="Wrapped output"
            code="2026-11-05T09:14:02Z GET /api/items 200 12ms cache=miss region=local request_id=9b1deb4d3b7d4bad"
          />
        </div>
      </Row>
    </Section>
  );
}
