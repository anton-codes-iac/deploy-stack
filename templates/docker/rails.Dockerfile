FROM ruby:3.2-slim
WORKDIR /app

RUN apt-get update -qq && apt-get install -y build-essential libpq-dev nodejs && rm -rf /var/lib/apt/lists/*

# Create unprivileged user
RUN groupadd -g 1001 appgroup && \
    useradd -u 1001 -g appgroup -s /bin/sh -m appuser

COPY Gemfile Gemfile.lock ./
RUN bundle install --without development test

# Copy code with explicit ownership
COPY --chown=appuser:appgroup . .

RUN SECRET_KEY_BASE_DUMMY=1 bundle exec rails assets:precompile

USER appuser
EXPOSE {{PORT}}

CMD ["bundle", "exec", "puma", "-C", "config/puma.rb"]