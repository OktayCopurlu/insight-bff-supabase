export default {
  test: {
    include: ["tests/remote-connectivity.test.mjs"],
    reporters: "dot",
    watch: false,
    hookTimeout: 20000,
    testTimeout: 30000,
  },
};
