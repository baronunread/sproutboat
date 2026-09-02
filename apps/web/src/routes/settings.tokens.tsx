import { createFileRoute } from "@tanstack/react-router";
import { CliCredentials } from "../account";

export const Route = createFileRoute("/settings/tokens")({ component: Tokens });

function Tokens() { return <CliCredentials />; }
