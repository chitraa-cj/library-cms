import SingleTypeEditor from "./single-type-editor";

export default function GlobalPage() {
  return (
    <SingleTypeEditor
      apiPath="global"
      title="Global Settings"
      description="Site-wide settings — site name, SEO defaults, and metadata used across the library website."
    />
  );
}
