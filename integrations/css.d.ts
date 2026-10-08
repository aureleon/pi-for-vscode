/** esbuild loads `.css` files that integrations import as text (see the `loader` in esbuild.mjs). */
declare module "*.css" {
  const text: string;
  export default text;
}
