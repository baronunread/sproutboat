import { CodeBlock, EmptyState } from "@sproutboat/ikada";

/** The first-run state shared by the overview and the sprouts list. */
export function EmptySprouts() {
  return (
    <EmptyState
      className="max-w-md"
      title="Deploy your first sprout"
      description="Deploy from a project directory and its route, version history and traffic appear here."
      action={
        <CodeBlock label="Deploy command" code={"sproutboat init hello\nsproutboat login\nsproutboat deploy hello"} />
      }
    />
  );
}
