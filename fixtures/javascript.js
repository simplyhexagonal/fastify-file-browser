function fibonacciSequence(n) {
  const sequence = [0, 1];

  for (let i = 2; i <= n; i++) {
    const a = sequence[i - 1];
    const b = sequence[i - 2];
    sequence.push(a + b);
  }

  return sequence;
}

console.log(fibonacciSequence(100));
