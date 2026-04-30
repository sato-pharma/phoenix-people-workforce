import { redirect } from "next/navigation";

export default function Home() {
  redirect("/payroll?tab=generate");
}
