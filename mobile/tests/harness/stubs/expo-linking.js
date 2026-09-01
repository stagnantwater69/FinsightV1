export const createURL = (routePath) => `finsight://${routePath}`;
export const openURL = async () => true;
export const getInitialURL = async () => null;
export const addEventListener = () => ({ remove() {} });
export const parse = (url) => ({ path: url, queryParams: {} });
export const useURL = () => null;

export default {
  createURL,
  openURL,
  getInitialURL,
  addEventListener,
  parse,
  useURL,
};
