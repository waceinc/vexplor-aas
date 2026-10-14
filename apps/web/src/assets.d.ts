/** Vite turns image imports into URL strings */
declare module '*.png' {
  const url: string;
  export default url;
}
