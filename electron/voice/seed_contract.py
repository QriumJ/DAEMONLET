"""Request seed contract, independent of model and conditioning identity."""
def valid_seed(value):
    if type(value) is not int or not 1 <= value <= 2147483647:
        raise ValueError('VOICE_SEED_INVALID')
    return value

def request_seed(request):
    seed = valid_seed(request.get('seed'))
    binding = request.get('binding', {})
    if 'effectiveSeed' in binding and valid_seed(binding['effectiveSeed']) != seed:
        raise ValueError('VOICE_SEED_MISMATCH')
    return seed
