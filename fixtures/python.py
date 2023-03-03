def prime_factors(n):
    factors = []
    divisor = 2
    
    while divisor <= n:
        if n % divisor == 0:
            factors.append(divisor)
            n /= divisor
        else:
            divisor += 1
            
    return factors

print(prime_factors(100))
