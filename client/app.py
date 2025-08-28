from flask import Flask, render_template

app = Flask(__name__)
app.config['API_BASE_URL'] = 'http://localhost:3000/api'


# Make API_BASE_URL available in all templates
@app.context_processor
def inject_globals():
    return {
    'API_BASE_URL': app.config['API_BASE_URL']
    }


@app.route('/')
def home():
    return render_template('index.html')


@app.route('/timetable')
def timetable():
    return render_template('timetable.html')


@app.route('/stops')
def stops():
    return render_template('stops.html')


@app.route('/routes')
def routes():
    return render_template('routes.html')


if __name__ == '__main__':
    app.run(debug=1)