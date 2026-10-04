/** Vite가 이미지 import를 URL 문자열로 바꿔 준다 */
declare module '*.png' {
  const url: string;
  export default url;
}
