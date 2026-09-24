import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getT } from "@/lib/i18n/server";
import { getSession } from "@/server/auth";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT()).meta.signIn };
}

export default async function Page() {
  if (await getSession()) redirect("/app");
  return <AuthForm mode="sign-in" />;
}
