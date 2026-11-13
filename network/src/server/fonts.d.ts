// Font files the invite page serves, bundled by the Data rule in wrangler.jsonc.
declare module "*.woff2" {
  const data: ArrayBuffer;
  export default data;
}
