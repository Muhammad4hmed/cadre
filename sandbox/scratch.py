"""Something for the agent to look at on first run."""


def fizzbuzz(n: int) -> str:
    if n % 15 == 0:
        return "FizzBuzz"
    if n % 3 == 0:
        return "Fizz"
    if n % 5 == 0:
        return "Buzz"
    return str(n)


if __name__ == "__main__":
    print(" ".join(fizzbuzz(i) for i in range(1, 21)))
